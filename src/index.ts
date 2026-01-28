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

		// High-fidelity dashboard for the root route.
		if (url.pathname === "/" && req.method === "GET") {
			const html = `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Feedback Intelligence Dashboard</title>
  <!-- Tailwind via CDN for rapid, modern styling -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- Chart.js for simple theme bar chart -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <!-- Lucide Icons for source + UI icons -->
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    :root {
      color-scheme: dark;
    }
    body {
      background: radial-gradient(circle at top, rgba(79,70,229,0.25), transparent 55%),
                  radial-gradient(circle at bottom, rgba(15,23,42,1), rgba(15,23,42,1));
    }
    .glass {
      background: rgba(15,23,42,0.8);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid rgba(148,163,184,0.25);
    }
  </style>
</head>
<body class="h-full min-h-screen text-slate-100 antialiased">
  <div class="min-h-screen flex flex-col">
    <!-- Top nav -->
    <header class="border-b border-slate-800/60 bg-gradient-to-r from-slate-950/80 via-slate-900/80 to-slate-950/80 backdrop-blur">
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="h-9 w-9 rounded-2xl bg-indigo-500/80 flex items-center justify-center shadow-lg shadow-indigo-500/40">
            <span class="text-lg font-semibold tracking-tight">FI</span>
          </div>
          <div>
            <h1 class="text-sm sm:text-base font-semibold tracking-tight">
              Feedback Intelligence Pipeline
            </h1>
            <p class="text-xs sm:text-sm text-slate-400">
              Cloudflare PM Intern · Noisy feedback in, actionable insights out.
            </p>
          </div>
        </div>
        <div class="flex items-center gap-3 text-xs sm:text-sm">
          <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
            <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            Live · Backed by Workers, D1 &amp; AI
          </span>
        </div>
      </div>
    </header>

    <!-- Main content -->
    <main class="flex-1">
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 lg:py-10">
        <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,2.3fr)_minmax(0,1fr)] gap-6 lg:gap-8 items-start">
          <!-- Left: metrics, chart, table -->
          <section class="space-y-6 lg:space-y-8">
            <!-- Sentiment Glance -->
            <div class="glass rounded-3xl p-5 sm:p-6 shadow-xl shadow-slate-950/60">
              <div class="flex items-center justify-between gap-4 mb-4">
                <div>
                  <h2 class="text-sm sm:text-base font-semibold tracking-tight">
                    Sentiment Glance
                  </h2>
                  <p class="text-xs sm:text-sm text-slate-400">
                    Instant read on how users are feeling across all feedback.
                  </p>
                </div>
                <div class="flex items-center gap-1 text-xs text-slate-400">
                  <span class="h-2 w-2 rounded-full bg-emerald-400"></span>
                  Realtime via /results
                </div>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <!-- Positive -->
                <div class="relative overflow-hidden rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 via-slate-900/60 to-slate-950/90 px-4 py-3.5 sm:py-4">
                  <div class="flex items-center justify-between gap-2">
                    <div>
                      <p class="text-[11px] uppercase tracking-[0.18em] text-emerald-300/80">
                        Positive
                      </p>
                      <p id="sentiment-positive-count" class="mt-1 text-2xl sm:text-3xl font-semibold text-emerald-100">
                        0
                      </p>
                    </div>
                    <div class="flex flex-col items-end gap-1 text-[11px] text-emerald-300/80">
                      <span class="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5">
                        <span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                        Lift
                      </span>
                      <span id="sentiment-positive-percent" class="text-[10px] text-emerald-200/80">
                        0%
                      </span>
                    </div>
                  </div>
                </div>

                <!-- Neutral -->
                <div class="relative overflow-hidden rounded-2xl border border-slate-500/20 bg-gradient-to-br from-slate-400/10 via-slate-900/60 to-slate-950/90 px-4 py-3.5 sm:py-4">
                  <div class="flex items-center justify-between gap-2">
                    <div>
                      <p class="text-[11px] uppercase tracking-[0.18em] text-slate-300/80">
                        Neutral
                      </p>
                      <p id="sentiment-neutral-count" class="mt-1 text-2xl sm:text-3xl font-semibold text-slate-100">
                        0
                      </p>
                    </div>
                    <div class="flex flex-col items-end gap-1 text-[11px] text-slate-300/80">
                      <span class="inline-flex items-center gap-1 rounded-full bg-slate-400/15 px-2 py-0.5">
                        <span class="h-1.5 w-1.5 rounded-full bg-slate-300"></span>
                        Baseline
                      </span>
                      <span id="sentiment-neutral-percent" class="text-[10px] text-slate-200/80">
                        0%
                      </span>
                    </div>
                  </div>
                </div>

                <!-- Negative -->
                <div class="relative overflow-hidden rounded-2xl border border-rose-500/25 bg-gradient-to-br from-rose-500/15 via-slate-900/60 to-slate-950/90 px-4 py-3.5 sm:py-4">
                  <div class="flex items-center justify-between gap-2">
                    <div>
                      <p class="text-[11px] uppercase tracking-[0.18em] text-rose-300/80">
                        Negative
                      </p>
                      <p id="sentiment-negative-count" class="mt-1 text-2xl sm:text-3xl font-semibold text-rose-100">
                        0
                      </p>
                    </div>
                    <div class="flex flex-col items-end gap-1 text-[11px] text-rose-300/80">
                      <span class="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5">
                        <span class="h-1.5 w-1.5 rounded-full bg-rose-400"></span>
                        Risk
                      </span>
                      <span id="sentiment-negative-percent" class="text-[10px] text-rose-100/80">
                        0%
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Theme bar chart + recent feedback table -->
            <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)] gap-6">
              <!-- Chart card -->
              <div class="glass rounded-3xl p-5 sm:p-6 shadow-xl shadow-slate-950/60">
                <div class="flex items-center justify-between gap-3 mb-4">
                  <div>
                    <h2 class="text-sm sm:text-base font-semibold tracking-tight">
                      Theme Distribution
                    </h2>
                    <p class="text-xs sm:text-sm text-slate-400">
                      Where product teams should focus: bugs vs feature requests and more.
                    </p>
                  </div>
                  <span class="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-[11px] text-indigo-200">
                    <span class="h-1.5 w-1.5 rounded-full bg-indigo-400"></span>
                    Chart.js · Live
                  </span>
                </div>
                <div class="h-64 sm:h-72">
                  <canvas id="themeChart"></canvas>
                </div>
              </div>

              <!-- Recent feedback table -->
              <div class="glass rounded-3xl p-5 sm:p-6 shadow-xl shadow-slate-950/60">
                <div class="flex items-center justify-between gap-3 mb-3">
                  <div>
                    <h2 class="text-sm sm:text-base font-semibold tracking-tight">
                      Recent Feedback
                    </h2>
                    <p class="text-xs sm:text-sm text-slate-400">
                      Enriched by Workers AI and persisted to D1.
                    </p>
                  </div>
                  <button id="refresh-button" class="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/60 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:border-indigo-500/70 hover:text-indigo-100 hover:bg-slate-900 transition">
                    <i data-lucide="refresh-ccw" class="w-3.5 h-3.5"></i>
                    Refresh
                  </button>
                </div>
                <div class="relative overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40">
                  <div class="max-h-80 overflow-auto scrollbar-thin scrollbar-thumb-slate-700/70 scrollbar-track-slate-900/60">
                    <table class="min-w-full text-left text-xs sm:text-sm">
                      <thead class="bg-slate-900/70 text-slate-300 sticky top-0 z-10">
                        <tr>
                          <th class="px-3 sm:px-4 py-2.5 font-medium">Source</th>
                          <th class="px-3 sm:px-4 py-2.5 font-medium">Feedback</th>
                          <th class="px-3 sm:px-4 py-2.5 font-medium">Sentiment</th>
                          <th class="px-3 sm:px-4 py-2.5 font-medium">Theme</th>
                          <th class="px-3 sm:px-4 py-2.5 font-medium">When</th>
                        </tr>
                      </thead>
                      <tbody id="feedback-table-body" class="divide-y divide-slate-800/70">
                        <!-- Rows injected by client-side JS -->
                      </tbody>
                    </table>
                  </div>
                  <div id="table-empty-state" class="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div class="flex flex-col items-center gap-2 text-center text-xs sm:text-sm text-slate-400">
                      <i data-lucide="inbox" class="w-5 h-5 text-slate-500"></i>
                      <p>No feedback yet. Use the Simulated Ingest panel to add some.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- Right: Simulated Ingest sidebar -->
          <aside class="glass rounded-3xl p-5 sm:p-6 shadow-xl shadow-slate-950/60">
            <div class="flex items-start justify-between gap-3 mb-4">
              <div>
                <h2 class="text-sm sm:text-base font-semibold tracking-tight">
                  Simulated Ingest
                </h2>
                <p class="text-xs sm:text-sm text-slate-400">
                  Paste raw feedback, send it through the pipeline, and watch the dashboard respond.
                </p>
              </div>
              <span class="inline-flex items-center gap-1 rounded-full border border-slate-700/80 bg-slate-900/70 px-2 py-0.5 text-[11px] text-slate-300">
                <i data-lucide="wand-2" class="w-3.5 h-3.5"></i>
                Magic
              </span>
            </div>

            <form id="ingest-form" class="space-y-4">
              <div class="space-y-2">
                <label for="source" class="block text-xs font-medium text-slate-300">
                  Feedback Source
                </label>
                <div class="relative">
                  <select
                    id="source"
                    name="source"
                    class="block w-full rounded-2xl border border-slate-700/80 bg-slate-900/80 px-3 py-2.5 pr-10 text-xs sm:text-sm text-slate-100 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/60 outline-none"
                  >
                    <option>Discord</option>
                    <option>GitHub</option>
                    <option>X</option>
                    <option>Intercom</option>
                    <option>Other</option>
                  </select>
                  <div class="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                    <i data-lucide="chevron-down" class="w-3.5 h-3.5 text-slate-400"></i>
                  </div>
                </div>
              </div>

              <div class="space-y-2">
                <label for="content" class="block text-xs font-medium text-slate-300">
                  Raw Feedback
                </label>
                <textarea
                  id="content"
                  name="content"
                  rows="5"
                  placeholder="Example: The analytics dashboard feels slow when loading charts, and it's hard to find the right filters."
                  class="block w-full rounded-2xl border border-slate-700/80 bg-slate-900/80 px-3 py-2.5 text-xs sm:text-sm text-slate-100 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/60 outline-none resize-none"
                  required
                ></textarea>
              </div>

              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 text-[11px] text-slate-400">
                  <span class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500/20 text-indigo-300">
                    <i data-lucide="cpu" class="w-3 h-3"></i>
                  </span>
                  <span>Workers AI classifies sentiment &amp; theme before persisting to D1.</span>
                </div>
              </div>

              <div class="flex items-center gap-3">
                <button
                  id="analyze-button"
                  type="submit"
                  class="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-indigo-500 px-4 py-2.5 text-xs sm:text-sm font-semibold text-white shadow-lg shadow-indigo-500/40 hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-slate-950 transition disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span id="analyze-button-label" class="inline-flex items-center gap-1">
                    <i data-lucide="sparkles" class="w-4 h-4"></i>
                    Analyze &amp; Ingest
                  </span>
                  <span
                    id="analyze-button-spinner"
                    class="hidden h-4 w-4 border-2 border-indigo-100/80 border-t-transparent rounded-full animate-spin"
                  ></span>
                </button>
              </div>

              <p id="ingest-status" class="text-[11px] text-slate-400 min-h-[1.25rem]">
                Paste feedback, hit Analyze, then watch sentiment &amp; themes update.
              </p>
            </form>
          </aside>
        </div>
      </div>
    </main>
  </div>

  <script>
    // State
    let themeChart;

    function computeSentimentStats(rows) {
      const counts = { Positive: 0, Neutral: 0, Negative: 0 };
      for (const row of rows) {
        if (row.sentiment && counts[row.sentiment] !== undefined) {
          counts[row.sentiment]++;
        }
      }
      const total = counts.Positive + counts.Neutral + counts.Negative || 1;
      return {
        counts,
        percents: {
          Positive: Math.round((counts.Positive / total) * 100),
          Neutral: Math.round((counts.Neutral / total) * 100),
          Negative: Math.round((counts.Negative / total) * 100),
        },
      };
    }

    function computeThemeStats(rows) {
      const themes = ["UI/UX", "Bug", "Performance", "Feature Request"];
      const counts = { "UI/UX": 0, "Bug": 0, "Performance": 0, "Feature Request": 0 };
      for (const row of rows) {
        if (row.theme && counts[row.theme] !== undefined) {
          counts[row.theme]++;
        }
      }
      return { themes, counts };
    }

    function formatRelativeTime(iso) {
      if (!iso) return "";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "";
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMin = Math.round(diffMs / 60000);
      if (diffMin < 1) return "Just now";
      if (diffMin < 60) return diffMin + " min ago";
      const diffHr = Math.round(diffMin / 60);
      if (diffHr < 24) return diffHr + " hr ago";
      const diffDay = Math.round(diffHr / 24);
      if (diffDay < 7) return diffDay + " d ago";
      return date.toLocaleDateString();
    }

    function createSourceIcon(source) {
      const s = (source || "").toLowerCase();
      if (s.includes("github")) return "github";
      if (s.includes("discord")) return "messages-square";
      if (s === "x" || s.includes("twitter")) return "twitter";
      if (s.includes("intercom")) return "message-circle";
      return "globe-2";
    }

    function createSentimentPill(sentiment) {
      const base = "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium";
      if (sentiment === "Positive") {
        return base + " bg-emerald-500/10 text-emerald-200 border border-emerald-500/40";
      }
      if (sentiment === "Negative") {
        return base + " bg-rose-500/10 text-rose-200 border border-rose-500/50";
      }
      return base + " bg-slate-500/10 text-slate-200 border border-slate-500/40";
    }

    function createThemePill(theme) {
      const base = "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium";
      if (theme === "Bug") {
        return base + " bg-rose-500/10 text-rose-200 border border-rose-500/40";
      }
      if (theme === "Feature Request") {
        return base + " bg-indigo-500/10 text-indigo-200 border border-indigo-500/40";
      }
      if (theme === "Performance") {
        return base + " bg-amber-500/10 text-amber-200 border border-amber-500/40";
      }
      return base + " bg-sky-500/10 text-sky-200 border border-sky-500/40";
    }

    async function fetchResults() {
      const res = await fetch("/results");
      if (!res.ok) {
        throw new Error("Failed to fetch results");
      }
      return await res.json();
    }

    function updateSentimentGlance(rows) {
      const { counts, percents } = computeSentimentStats(rows);
      document.getElementById("sentiment-positive-count").textContent = counts.Positive;
      document.getElementById("sentiment-neutral-count").textContent = counts.Neutral;
      document.getElementById("sentiment-negative-count").textContent = counts.Negative;

      document.getElementById("sentiment-positive-percent").textContent = percents.Positive + "%";
      document.getElementById("sentiment-neutral-percent").textContent = percents.Neutral + "%";
      document.getElementById("sentiment-negative-percent").textContent = percents.Negative + "%";
    }

    function updateThemeChart(rows) {
      const { themes, counts } = computeThemeStats(rows);
      const data = themes.map((t) => counts[t]);
      const ctx = document.getElementById("themeChart").getContext("2d");
      if (themeChart) {
        themeChart.data.datasets[0].data = data;
        themeChart.update();
        return;
      }
      themeChart = new Chart(ctx, {
        type: "bar",
        data: {
          labels: themes,
          datasets: [
            {
              label: "Feedback count",
              data,
              backgroundColor: [
                "rgba(56, 189, 248, 0.75)",   // UI/UX
                "rgba(248, 113, 113, 0.85)", // Bug
                "rgba(245, 158, 11, 0.85)",  // Performance
                "rgba(129, 140, 248, 0.9)",  // Feature Request
              ],
              borderRadius: 8,
              borderWidth: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              labels: {
                color: "#e5e7eb",
                font: { size: 11 },
              },
            },
            tooltip: {
              backgroundColor: "rgba(15,23,42,0.95)",
              borderColor: "rgba(148,163,184,0.6)",
              borderWidth: 1,
              padding: 10,
              titleFont: { size: 11 },
              bodyFont: { size: 11 },
            },
          },
          scales: {
            x: {
              ticks: {
                color: "#9ca3af",
                font: { size: 11 },
              },
              grid: {
                display: false,
              },
            },
            y: {
              ticks: {
                color: "#6b7280",
                font: { size: 10 },
                precision: 0,
              },
              grid: {
                color: "rgba(31,41,55,0.9)",
              },
            },
          },
        },
      });
    }

    function updateFeedbackTable(rows) {
      const tbody = document.getElementById("feedback-table-body");
      tbody.innerHTML = "";

      if (!rows.length) {
        document.getElementById("table-empty-state").classList.remove("hidden");
        return;
      }
      document.getElementById("table-empty-state").classList.add("hidden");

      const recent = rows.slice(0, 40);

      for (const row of recent) {
        const tr = document.createElement("tr");
        tr.className = "hover:bg-slate-900/60 transition";

        const srcIcon = createSourceIcon(row.source);
        const srcCell = document.createElement("td");
        srcCell.className = "px-3 sm:px-4 py-3 align-top text-xs sm:text-sm text-slate-200 whitespace-nowrap";
        srcCell.innerHTML = \`
          <div class="flex items-center gap-2">
            <span class="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-900/80 border border-slate-700/80">
              <i data-lucide="\${srcIcon}" class="w-3.5 h-3.5 text-slate-200"></i>
            </span>
            <span class="max-w-[8rem] truncate" title="\${row.source || ""}">\${row.source || "Unknown"}</span>
          </div>
        \`;

        const contentCell = document.createElement("td");
        contentCell.className = "px-3 sm:px-4 py-3 align-top text-xs sm:text-sm text-slate-200";
        const safeContent = row.content || "";
        contentCell.innerHTML = \`
          <div class="line-clamp-3" title="\${safeContent.replace(/"/g, '&quot;')}">
            \${safeContent}
          </div>
        \`;

        const sentimentCell = document.createElement("td");
        sentimentCell.className = "px-3 sm:px-4 py-3 align-top text-xs sm:text-sm text-slate-200 whitespace-nowrap";
        const sentiment = row.sentiment || "Neutral";
        sentimentCell.innerHTML = \`
          <span class="\${createSentimentPill(sentiment)}">
            \${sentiment}
          </span>
        \`;

        const themeCell = document.createElement("td");
        themeCell.className = "px-3 sm:px-4 py-3 align-top text-xs sm:text-sm text-slate-200 whitespace-nowrap";
        const theme = row.theme || "Feature Request";
        themeCell.innerHTML = \`
          <span class="\${createThemePill(theme)}">
            \${theme}
          </span>
        \`;

        const whenCell = document.createElement("td");
        whenCell.className = "px-3 sm:px-4 py-3 align-top text-xs sm:text-sm text-slate-400 whitespace-nowrap";
        whenCell.textContent = formatRelativeTime(row.timestamp);

        tr.appendChild(srcCell);
        tr.appendChild(contentCell);
        tr.appendChild(sentimentCell);
        tr.appendChild(themeCell);
        tr.appendChild(whenCell);

        tbody.appendChild(tr);
      }
    }

    async function refreshDashboard(opts) {
      const { silent } = opts || {};
      try {
        const rows = await fetchResults();
        updateSentimentGlance(rows);
        updateThemeChart(rows);
        updateFeedbackTable(rows);
        if (!silent) {
          const status = document.getElementById("ingest-status");
          if (status) {
            status.textContent = "Dashboard updated from live /results data.";
          }
        }
      } catch (err) {
        console.error(err);
        if (!silent) {
          const status = document.getElementById("ingest-status");
          if (status) {
            status.textContent = "Unable to refresh dashboard. Check the Worker logs.";
            status.classList.remove("text-slate-400");
            status.classList.add("text-rose-300");
          }
        }
      } finally {
        if (window.lucide) {
          window.lucide.createIcons();
        }
      }
    }

    function setAnalyzeLoading(isLoading) {
      const button = document.getElementById("analyze-button");
      const label = document.getElementById("analyze-button-label");
      const spinner = document.getElementById("analyze-button-spinner");
      if (!button || !label || !spinner) return;
      button.disabled = isLoading;
      if (isLoading) {
        spinner.classList.remove("hidden");
        label.classList.add("opacity-70");
      } else {
        spinner.classList.add("hidden");
        label.classList.remove("opacity-70");
      }
    }

    async function handleSimulatedIngest(event) {
      event.preventDefault();
      const form = document.getElementById("ingest-form");
      if (!form) return;
      const source = document.getElementById("source").value;
      const content = document.getElementById("content").value.trim();
      const status = document.getElementById("ingest-status");

      if (!content) {
        if (status) {
          status.textContent = "Please paste feedback text before analyzing.";
          status.classList.remove("text-slate-400", "text-emerald-300");
          status.classList.add("text-amber-300");
        }
        return;
      }

      setAnalyzeLoading(true);
      if (status) {
        status.textContent = "Sending feedback to /ingest and kicking off Workflow…";
        status.classList.remove("text-emerald-300", "text-rose-300", "text-amber-300");
        status.classList.add("text-slate-400");
      }

      try {
        const res = await fetch("/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([{ source, content }]),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Ingest failed");
        }

        if (status) {
          status.textContent = "Workflow started. We’ll pull fresh results in a moment…";
        }

        // Give the Workflow a moment to run, then refresh.
        setTimeout(() => {
          refreshDashboard({ silent: false });
        }, 1500);

        if (status) {
          status.classList.remove("text-slate-400", "text-rose-300", "text-amber-300");
          status.classList.add("text-emerald-300");
        }
      } catch (err) {
        console.error(err);
        if (status) {
          status.textContent = "Something went wrong while ingesting. Check the browser console & Worker logs.";
          status.classList.remove("text-slate-400", "text-emerald-300", "text-amber-300");
          status.classList.add("text-rose-300");
        }
      } finally {
        setAnalyzeLoading(false);
        if (window.lucide) {
          window.lucide.createIcons();
        }
      }
    }

    window.addEventListener("DOMContentLoaded", () => {
      const form = document.getElementById("ingest-form");
      if (form) {
        form.addEventListener("submit", handleSimulatedIngest);
      }
      const refresh = document.getElementById("refresh-button");
      if (refresh) {
        refresh.addEventListener("click", (e) => {
          e.preventDefault();
          refreshDashboard({ silent: false });
        });
      }
      refreshDashboard({ silent: true });
      if (window.lucide) {
        window.lucide.createIcons();
      }
    });
  </script>
</body>
</html>`;

			return new Response(html, {
				status: 200,
				headers: {
					"content-type": "text/html; charset=utf-8",
				},
			});
		}

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
