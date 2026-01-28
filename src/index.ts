import {
	WorkflowEntrypoint,
	WorkflowEvent,
	WorkflowStep,
} from "cloudflare:workers";

/**
 * Augment the generated `Env` type so TypeScript knows about our bindings.
 * The actual bindings are configured in `wrangler.jsonc`, but without this
 * declaration TS will complain that `env.DB` / `env.AI` do not exist.
 */
declare global {
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
			AI: Ai;
		}
	}
}

/**
 * Feedback Intelligence Pipeline
 *
 * High-level architecture:
 * - The HTTP Worker exposes:
 *   - POST `/ingest`  → accepts an array of raw feedback items and spawns a Workflow instance.
 *   - GET  `/results` → reads analyzed feedback rows from the D1 database.
 * - The Workflow (`MyWorkflow`) is responsible for:
 *   - Iterating over each feedback item in the batch.
 *   - Calling Workers AI to classify sentiment + theme.
 *   - Persisting the enriched record into the D1 `feedback` table.
 *
 * This separation keeps the HTTP surface simple while the long‑running,
 * potentially expensive AI + database work is handled reliably by Workflows.
 */

/**
 * Basic shape of feedback coming from clients into /ingest.
 * This is intentionally minimal and matches the assignment example.
 */
export interface IncomingFeedback {
	source: string;
	content: string;
}

/**
 * Sentiment and theme are constrained so the AI output is normalized.
 */
export type Sentiment = "Positive" | "Neutral" | "Negative";

export type Theme = "UI/UX" | "Bug" | "Performance" | "Feature Request";

/**
 * Row as stored in the D1 `feedback` table.
 * (Assumes there is a numeric primary key `id` and an ISO timestamp column.)
 */
export interface FeedbackRecord {
	id: number;
	source: string;
	content: string;
	sentiment: Sentiment;
	theme: Theme;
	timestamp: string;
}

/**
 * Payload passed from the Worker into the Workflow.
 * Keeping it small and explicit makes it easy to evolve later.
 */
export interface WorkflowParams {
	items: IncomingFeedback[];
}

/**
 * Workflow implementation that:
 *  1. Loops over all feedback items in the batch.
 *  2. For each:
 *     a. Calls Workers AI to classify sentiment + theme.
 *     b. Inserts the enriched record into the D1 database.
 */
export class MyWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(
		event: WorkflowEvent<WorkflowParams>,
		step: WorkflowStep,
	): Promise<void> {
		const items = event.payload?.items ?? [];

		if (!Array.isArray(items) || items.length === 0) {
			// Nothing to process for this instance.
			return;
		}

		for (const item of items) {
			// Ensure we never store obviously malformed data.
			if (!item || !item.source || !item.content) continue;

			// ---- AI Step: classify sentiment and theme for this one item ----
			const analysis = await step.do(
				`analyze feedback from ${item.source}`,
				async () => {
					// Prompt is designed to strongly bias the model towards a strict JSON response.
					const systemPrompt =
						"You are an assistant that categorizes user feedback for a product team. " +
						"Always respond with STRICT, VALID JSON only. Do not include explanations or extra text.";

					const userPrompt =
						[
							"Analyze the following user feedback text.",
							"",
							"Return a JSON object with exactly these keys:",
							'- "sentiment": one of ["Positive", "Neutral", "Negative"]',
							'- "theme": one of ["UI/UX", "Bug", "Performance", "Feature Request"]',
							"",
							"Pick the single best sentiment and single best theme.",
							"",
							"Feedback text:",
							`"""${item.content}"""`,
						].join("\n");

					const aiResponse: any = await this.env.AI.run(
						"@cf/meta/llama-3-8b-instruct",
						{
							messages: [
								{ role: "system", content: systemPrompt },
								{ role: "user", content: userPrompt },
							],
						},
					);

					// Text models return a `response` string which should be JSON per our prompt.
					const rawText: string =
						typeof aiResponse?.response === "string"
							? aiResponse.response
							: JSON.stringify(aiResponse);

					let sentiment: Sentiment = "Neutral";
					let theme: Theme = "Feature Request";

					try {
						const parsed = JSON.parse(rawText) as {
							sentiment?: string;
							theme?: string;
						};

						const sentimentUpper = (parsed.sentiment ?? "").trim();
						const themeValue = (parsed.theme ?? "").trim();

						const validSentiments: Sentiment[] = [
							"Positive",
							"Neutral",
							"Negative",
						];
						const validThemes: Theme[] = [
							"UI/UX",
							"Bug",
							"Performance",
							"Feature Request",
						];

						if (
							validSentiments.includes(
								sentimentUpper as Sentiment,
							)
						) {
							sentiment = sentimentUpper as Sentiment;
						}

						if (validThemes.includes(themeValue as Theme)) {
							theme = themeValue as Theme;
						}
					} catch (err) {
						// If parsing fails, we still proceed with safe defaults.
						console.warn(
							"Failed to parse AI response as JSON:",
							err,
							rawText,
						);
					}

					return { sentiment, theme };
				},
			);

			// ---- Persistence Step: write enriched feedback into D1 ----
			await step.do(
				`persist feedback from ${item.source}`,
				async () => {
					const now = new Date().toISOString();

					// Table schema (expected):
					// feedback(id, source, content, sentiment, theme, timestamp)
					await this.env.DB.prepare(
						`
						INSERT INTO feedback (source, content, sentiment, theme, timestamp)
						VALUES (?1, ?2, ?3, ?4, ?5)
					`,
					)
						.bind(
							item.source,
							item.content,
							analysis.sentiment,
							analysis.theme,
							now,
						)
						.run();
				},
			);
		}
	}
}

/**
 * HTTP Worker entrypoint.
 *
 * - POST /ingest
 *   Body: JSON array of `{ source: string; content: string }`.
 *   Behavior: starts a Workflow instance to analyze and persist the batch.
 *
 * - GET /results
 *   Behavior: returns all rows from the D1 `feedback` table so you can
 *   inspect what the Workflow has produced.
 */
export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === "/ingest" && req.method === "POST") {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return Response.json(
					{ error: "Request body must be valid JSON." },
					{ status: 400 },
				);
			}

			if (!Array.isArray(body)) {
				return Response.json(
					{
						error:
							"Expected a JSON array of feedback objects, e.g. [{ \"source\": \"Discord\", \"content\": \"...\" }].",
					},
					{ status: 400 },
				);
			}

			const items: IncomingFeedback[] = (body as any[]).map(
				(entry): IncomingFeedback => ({
					source: String((entry as any).source ?? "").trim(),
					content: String((entry as any).content ?? "").trim(),
				}),
			);

			const validItems = items.filter(
				(i) => i.source.length > 0 && i.content.length > 0,
			);

			if (validItems.length === 0) {
				return Response.json(
					{
						error:
							"No valid feedback items found. Each item must include non-empty `source` and `content` fields.",
					},
					{ status: 400 },
				);
			}

			// Kick off a new Workflow instance to process this batch.
			const instance = await env.MY_WORKFLOW.create({
				params: { items: validItems },
			});

			return Response.json(
				{
					message: "Feedback batch accepted for processing.",
					workflowInstanceId: instance.id,
				},
				{ status: 202 },
			);
		}

		if (url.pathname === "/results" && req.method === "GET") {
			// Read all analyzed feedback from the D1 table so you can inspect it.
			const query = `
				SELECT id, source, content, sentiment, theme, timestamp
				FROM feedback
				ORDER BY datetime(timestamp) DESC, id DESC
			`;

			const result = await env.DB.prepare(query).all<FeedbackRecord>();

			return Response.json(result.results ?? []);
		}

		// Small helpful message for any other route.
		return Response.json(
			{
				error: "Not found.",
				endpoints: {
					ingest: {
						method: "POST",
						path: "/ingest",
						bodyExample: [
							{
								source: "Discord",
								content:
									"The dashboard feels slow when switching tabs.",
							},
						],
					},
					results: {
						method: "GET",
						path: "/results",
					},
				},
			},
			{ status: 404 },
		);
	},
};
