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
<html lang="en" class="h-full" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cloudflare Feedback Sentinel AI</title>
  <!-- Inter typeface (professional SaaS default) -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <!-- Tailwind config must be defined before the CDN script -->
  <script>
    tailwind = {
      config: {
        theme: {
          extend: {
            fontFamily: {
              sans: ["Inter", "ui-sans-serif", "system-ui", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"],
            },
          },
        },
      },
    };
  </script>
  <!-- Tailwind via CDN for rapid, modern styling -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- Chart.js for simple theme bar chart -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <!-- Lucide Icons for source + UI icons -->
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    /* Tailwind's animate-ping equivalent, but duration is controlled by --pulse-duration */
    @keyframes ping {
      75%, 100% {
        transform: scale(2);
        opacity: 0;
      }
    }
    /* Cloudflare palette */
    :root {
      --cf-orange: #F38020;
      --cf-blue: #0051C3;
      --cf-slate: #1A1A1A;

      --ease: 0.3s ease;
      --pulse-duration: 20s; /* shared rhythm for background + status */
    }

    html {
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial;
      transition: background-color var(--ease), color var(--ease);
    }

    /* Theme tokens (light/dark) */
    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0F172A; /* deep slate base */
      --text: #f8fafc;
      --muted: rgba(59, 59, 59, 0.75);
      --glass-bg: rgba(255, 255, 255, 0.05); /* bg-white/5 */
      --card-border: rgba(148, 163, 184, 0.18);
      --shadow: rgba(0, 0, 0, 0.55);
    }
    html[data-theme="light"] {
      color-scheme: light;
      --bg: #F8FAFC; /* crisp base */
      --text: #0F172A; /* slate-900 primary */
      --muted: #475569; /* slate-600 secondary */
      --glass-bg: rgba(255, 255, 255, 0.80); /* bg-white/80 for readability */
      --card-border: rgba(15, 23, 42, 0.12);
      --shadow: rgba(15, 23, 42, 0.10);
    }

    /* Prevent background "leaks" during force-scroll/overscroll */
    html, body {
      min-height: 100%;
      background-color: var(--bg);
    }

    /* Pulsating Mesh Gradient (fixed behind glass) */
    @keyframes breathe {
      0% {
        opacity: 0.95;
      }
      50% {
        opacity: 0.78;
      }
      100% {
        opacity: 0.95;
      }
    }

    body {
      color: var(--text);
      transition: background var(--ease), color var(--ease);
      position: relative;
      isolation: isolate; /* guarantees z-index layering works as intended */
    }

    body::before {
      content: "";
      position: fixed;
      inset: -30vh -30vw; /* oversized to cover overscroll gaps */
      z-index: -1;
      /* Three high-blur blobs: Orange, Indigo, Deep Slate (reduced blue saturation) */
      background:
        radial-gradient(1100px 800px at var(--o-x, 22%) var(--o-y, 18%), rgba(243, 128, 32, 0.55), transparent 62%),
        radial-gradient(1200px 850px at var(--i-x, 74%) var(--i-y, 22%), rgba(79, 70, 229, 0.34), transparent 64%),
        radial-gradient(1300px 900px at var(--s-x, 55%) var(--s-y, 85%), rgba(15, 23, 42, 0.55), transparent 70%),
        linear-gradient(180deg, var(--bg), var(--bg));
      background-attachment: fixed;
      background-repeat: no-repeat;
      background-size: cover;
      pointer-events: none;
      transform: translateZ(0);
      filter: blur(0px); /* gradients are already large/soft; keep crisp glass edges */
      /* Animate via CSS variables for subtle, living motion */
      animation: breathe var(--pulse-duration) ease-in-out infinite;
    }

    /* Animate blob anchor points + opacity (subtle) */
    body::before {
      --o-x: 22%;
      --o-y: 18%;
      --i-x: 74%;
      --i-y: 22%;
      --s-x: 55%;
      --s-y: 85%;
    }
    @keyframes breathe {
      0% {
        --o-x: 22%; --o-y: 18%;
        --i-x: 74%; --i-y: 22%;
        --s-x: 55%; --s-y: 85%;
        opacity: 0.95;
      }
      50% {
        --o-x: 28%; --o-y: 14%;
        --i-x: 68%; --i-y: 30%;
        --s-x: 52%; --s-y: 78%;
        opacity: 0.80;
      }
      100% {
        --o-x: 22%; --o-y: 18%;
        --i-x: 74%; --i-y: 22%;
        --s-x: 55%; --s-y: 85%;
        opacity: 0.95;
      }
    }

    .glass {
      background: var(--glass-bg);
      backdrop-filter: blur(28px); /* ~backdrop-blur-xl */
      -webkit-backdrop-filter: blur(28px);
      border: 1px solid var(--card-border);
      /* Soft shadows (Apple-style) so mesh gradient stays visible */
      box-shadow:
        0 12px 30px rgba(15, 23, 42, 0.10),
        0 2px 10px rgba(15, 23, 42, 0.06);
      transition: background-color var(--ease), border-color var(--ease), box-shadow var(--ease);
    }

    .soft-divider {
      border-color: color-mix(in srgb, var(--card-border) 55%, transparent);
    }

    .chip {
      transition: background-color var(--ease), border-color var(--ease), color var(--ease);
    }

    .card {
      transition: transform var(--ease), background-color var(--ease), border-color var(--ease), box-shadow var(--ease);
      will-change: transform;
    }
    .card:hover {
      transform: scale(1.01);
    }

    /* Icon logos */
    .brand-logo {
      filter: saturate(1.05);
    }
  </style>
</head>
<body class="h-full min-h-screen antialiased">
  <div class="min-h-screen flex flex-col">
    <!-- Top nav -->
    <header class="border-b soft-divider bg-gradient-to-r from-black/30 via-black/10 to-black/30 backdrop-blur">
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <!-- Cloudflare logo (inline SVG) -->
          <div class="h-8 w-8 mr-1 rounded-2xl glass flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 64 64" fill="none" aria-label="Cloudflare" role="img">
              <path d="M23.5 44.6H49.8c5 0 9.2-4.1 9.2-9.2 0-4.7-3.6-8.7-8.3-9.1C49.1 17.3 41.8 11 32.9 11c-7.6 0-14.1 4.6-16.9 11.2-.6-.1-1.2-.1-1.9-.1-6.2 0-11.2 5-11.2 11.2 0 5.9 4.6 10.7 10.4 11.2h10.2z" fill="url(#cfGrad)"/>
              <defs>
                <linearGradient id="cfGrad" x1="10" y1="12" x2="54" y2="52" gradientUnits="userSpaceOnUse">
                  <stop stop-color="#F38020"/>
                  <stop offset="0.55" stop-color="#F38020"/>
                  <stop offset="1" stop-color="#0051C3"/>
                </linearGradient>
              </defs>
            </svg>
          </div>
          <div>
            <h1 class="text-sm sm:text-base font-semibold tracking-tight">
              Cloudflare Feedback Sentinel AI
            </h1>
            <p class="text-xs sm:text-sm" style="color: var(--muted);">
              Professional feedback intelligence console · Workflows + D1 + Workers AI
            </p>
          </div>
        </div>
        <div class="flex items-center gap-3 text-xs sm:text-sm">
          <!-- Sentinel Active indicator w/ tooltip -->
          <div class="relative group">
            <span class="chip inline-flex items-center gap-2 px-2.5 py-1 rounded-full border soft-divider"
                  style="background: color-mix(in srgb, var(--cf-blue) 10%, transparent); color: color-mix(in srgb, var(--text) 88%, transparent);">
              <span class="relative inline-flex h-2.5 w-2.5 items-center justify-center">
                <!-- Sync pulse rhythm with background via --pulse-duration -->
                <span class="absolute inline-flex h-2.5 w-2.5 rounded-full opacity-40"
                      style="background: #F38020; animation: ping var(--pulse-duration) ease-in-out infinite;"></span>
                <span class="inline-flex h-2 w-2 rounded-full"
                      style="background:#F38020; box-shadow:
                        0 0 0.55rem rgba(243,128,32,0.85),
                        0 0 1.25rem rgba(243,128,32,0.45),
                        0 0 2.2rem rgba(79,70,229,0.22);"></span>
              </span>
              <span>Sentinel active</span>
            </span>
            <div class="pointer-events-none absolute right-0 top-full mt-2 hidden group-hover:block">
              <div class="glass rounded-2xl px-3 py-2 text-[11px] leading-snug"
                   style="min-width: 20rem; color: color-mix(in srgb, var(--text) 90%, transparent);">
                Intelligence Pipeline Active · <span class="font-semibold">MY_WORKFLOW</span>
              </div>
            </div>
          </div>

          <!-- Light/Dark toggle (top-right, premium icon) -->
          <button id="theme-toggle"
            class="chip inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-medium border soft-divider hover:opacity-90"
            style="background: color-mix(in srgb, var(--card) 75%, transparent);"
            type="button"
            aria-label="Toggle theme"
            title="Toggle Light/Dark">
            <i id="theme-icon" data-lucide="moon" class="w-4 h-4"></i>
            <span id="theme-label">Dark</span>
          </button>
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
            <div class="glass card rounded-3xl p-5 sm:p-6">
              <div class="flex items-center justify-between gap-4 mb-4">
                <div>
                  <h2 class="text-sm sm:text-base font-semibold tracking-tight">
                    Sentiment Glance
                  </h2>
                  <p class="text-xs sm:text-sm" style="color: var(--muted);">
                    Instant read on how users are feeling across all feedback.
                  </p>
                </div>
                <div class="flex items-center gap-1 text-xs" style="color: var(--muted);">
                  <span class="h-2 w-2 rounded-full bg-emerald-400"></span>
                  Realtime via /results
                </div>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <!-- Positive -->
                <div class="relative overflow-hidden rounded-2xl border px-4 py-3.5 sm:py-4 card"
                     style="border-color: color-mix(in srgb, #10b981 28%, transparent); background: linear-gradient(135deg, color-mix(in srgb, #10b981 18%, transparent), color-mix(in srgb, var(--card) 92%, transparent));">
                  <div class="flex items-center justify-between gap-2">
                    <div>
                      <p class="text-[11px] uppercase tracking-[0.18em]" style="color: color-mix(in srgb, #10b981 80%, var(--text));">
                        Positive
                      </p>
                      <p id="sentiment-positive-count" class="mt-1 text-2xl sm:text-3xl font-semibold tabular-nums">
                        0
                      </p>
                    </div>
                    <div class="flex flex-col items-end gap-1 text-[11px]" style="color: color-mix(in srgb, #10b981 85%, var(--text));">
                      <span class="chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 border"
                            style="background: color-mix(in srgb, #10b981 14%, transparent); border-color: color-mix(in srgb, #10b981 28%, transparent);">
                        <span class="h-1.5 w-1.5 rounded-full" style="background: #10b981;"></span>
                        Lift
                      </span>
                      <span id="sentiment-positive-percent" class="text-[10px]" style="color: color-mix(in srgb, #10b981 70%, var(--text));">
                        0%
                      </span>
                    </div>
                  </div>
                </div>

                <!-- Neutral -->
                <div class="relative overflow-hidden rounded-2xl border px-4 py-3.5 sm:py-4 card"
                     style="border-color: color-mix(in srgb, var(--card-border) 75%, transparent); background: linear-gradient(135deg, color-mix(in srgb, #94a3b8 12%, transparent), color-mix(in srgb, var(--card) 92%, transparent));">
                  <div class="flex items-center justify-between gap-2">
                    <div>
                      <p class="text-[11px] uppercase tracking-[0.18em]" style="color: color-mix(in srgb, var(--text) 72%, transparent);">
                        Neutral
                      </p>
                      <p id="sentiment-neutral-count" class="mt-1 text-2xl sm:text-3xl font-semibold tabular-nums">
                        0
                      </p>
                    </div>
                    <div class="flex flex-col items-end gap-1 text-[11px]" style="color: color-mix(in srgb, var(--text) 70%, transparent);">
                      <span class="chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 border"
                            style="background: color-mix(in srgb, #94a3b8 12%, transparent); border-color: color-mix(in srgb, #94a3b8 22%, transparent);">
                        <span class="h-1.5 w-1.5 rounded-full" style="background: #94a3b8;"></span>
                        Baseline
                      </span>
                      <span id="sentiment-neutral-percent" class="text-[10px]" style="color: color-mix(in srgb, var(--text) 60%, transparent);">
                        0%
                      </span>
                    </div>
                  </div>
                </div>

                <!-- Negative -->
                <div class="relative overflow-hidden rounded-2xl border px-4 py-3.5 sm:py-4 card"
                     style="border-color: color-mix(in srgb, #f43f5e 30%, transparent); background: linear-gradient(135deg, color-mix(in srgb, #f43f5e 18%, transparent), color-mix(in srgb, var(--card) 92%, transparent));">
                  <div class="flex items-center justify-between gap-2">
                    <div>
                      <p class="text-[11px] uppercase tracking-[0.18em]" style="color: color-mix(in srgb, #f43f5e 78%, var(--text));">
                        Negative
                      </p>
                      <p id="sentiment-negative-count" class="mt-1 text-2xl sm:text-3xl font-semibold tabular-nums">
                        0
                      </p>
                    </div>
                    <div class="flex flex-col items-end gap-1 text-[11px]" style="color: color-mix(in srgb, #f43f5e 85%, var(--text));">
                      <span class="chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 border"
                            style="background: color-mix(in srgb, #f43f5e 14%, transparent); border-color: color-mix(in srgb, #f43f5e 30%, transparent);">
                        <span class="h-1.5 w-1.5 rounded-full" style="background: #f43f5e;"></span>
                        Risk
                      </span>
                      <span id="sentiment-negative-percent" class="text-[10px]" style="color: color-mix(in srgb, #f43f5e 70%, var(--text));">
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
              <div class="glass card rounded-3xl p-5 sm:p-6">
                <div class="flex items-center justify-between gap-3 mb-4">
                  <div>
                    <h2 class="text-sm sm:text-base font-semibold tracking-tight">
                      Intelligence Coverage
                    </h2>
                    <p class="text-xs sm:text-sm" style="color: var(--muted);">
                      A high-level radar view of how feedback spans key themes.
                    </p>
                  </div>
                  <span class="chip inline-flex items-center gap-1 rounded-full border soft-divider px-2 py-0.5 text-[11px]"
                        style="background: color-mix(in srgb, var(--cf-blue) 10%, transparent); color: color-mix(in srgb, var(--text) 80%, transparent);">
                    <span class="h-1.5 w-1.5 rounded-full" style="background: var(--cf-blue);"></span>
                    Chart.js · Radar
                  </span>
                </div>
                <div class="h-64 sm:h-72">
                  <canvas id="themeChart"></canvas>
                </div>
              </div>

              <!-- Recent feedback table -->
              <div class="glass card rounded-3xl p-5 sm:p-6">
                <div class="flex items-center justify-between gap-3 mb-3">
                  <div>
                    <h2 class="text-sm sm:text-base font-semibold tracking-tight">
                      Recent Feedback
                    </h2>
                    <p class="text-xs sm:text-sm" style="color: var(--muted);">
                      Enriched by Workers AI and persisted to D1.
                    </p>
                  </div>
                  <button id="refresh-button" class="chip inline-flex items-center gap-1.5 rounded-full border soft-divider px-2.5 py-1.5 text-[11px] font-medium hover:opacity-90 transition"
                          style="background: color-mix(in srgb, var(--card) 78%, transparent); color: color-mix(in srgb, var(--text) 85%, transparent);">
                    <i data-lucide="refresh-ccw" class="w-3.5 h-3.5"></i>
                    Refresh
                  </button>
                </div>
                <div class="relative overflow-hidden rounded-2xl border soft-divider"
                     style="background: color-mix(in srgb, var(--card) 65%, transparent);">
                  <div class="max-h-80 overflow-auto scrollbar-thin scrollbar-thumb-slate-700/70 scrollbar-track-slate-900/60">
                    <!-- table-fixed + explicit column widths prevents badge/content collisions -->
                    <table class="min-w-full table-fixed text-left text-xs sm:text-sm">
                      <thead class="sticky top-0 z-10"
                             style="background: color-mix(in srgb, var(--card) 90%, transparent); color: color-mix(in srgb, var(--text) 70%, transparent);">
                        <tr>
                          <th class="w-[9.5rem] px-3 sm:px-4 py-2.5 font-medium">Source</th>
                          <th class="px-3 sm:px-4 py-2.5 font-medium">Feedback</th>
                          <th class="w-[9.5rem] px-3 sm:px-4 py-2.5 font-medium">Status</th>
                          <th class="w-[7.5rem] px-3 sm:px-4 py-2.5 font-medium">Sentiment</th>
                          <th class="w-[9.5rem] px-3 sm:px-4 py-2.5 font-medium">Theme</th>
                          <th class="w-[6.5rem] px-3 sm:px-4 py-2.5 font-medium">When</th>
                        </tr>
                      </thead>
                      <tbody id="feedback-table-body" style="border-top: 1px solid color-mix(in srgb, var(--card-border) 60%, transparent);">
                        <!-- Rows injected by client-side JS -->
                      </tbody>
                    </table>
                  </div>
                  <div id="table-empty-state" class="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div class="flex flex-col items-center gap-2 text-center text-xs sm:text-sm" style="color: var(--muted);">
                      <i data-lucide="inbox" class="w-5 h-5" style="color: color-mix(in srgb, var(--muted) 75%, transparent);"></i>
                      <p>No feedback yet. Use the Simulated Ingest panel to add some.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- Right: Simulated Ingest sidebar -->
          <aside class="glass card rounded-3xl p-5 sm:p-6 pb-8">
            <div class="flex items-start justify-between gap-3 mb-4">
              <div>
                <h2 class="text-sm sm:text-base font-semibold tracking-tight">
                  Simulated Ingest
                </h2>
                <p class="text-xs sm:text-sm" style="color: var(--muted);">
                  In production, this Sentinel typically fetches data via automated webhooks (GitHub Webhooks, Discord API).
                  For this prototype, enter a piece of feedback below to simulate a real-time ingestion pipeline.
                </p>
              </div>
              <span class="chip inline-flex items-center gap-1 rounded-full border soft-divider px-2 py-0.5 text-[11px]"
                    style="background: color-mix(in srgb, var(--cf-orange) 12%, transparent); color: color-mix(in srgb, var(--text) 80%, transparent);">
                <i data-lucide="wand-2" class="w-3.5 h-3.5"></i>
                Magic
              </span>
            </div>

            <form id="ingest-form" class="space-y-5">
              <div class="space-y-2">
                <label for="source" class="block text-xs font-medium" style="color: color-mix(in srgb, var(--text) 78%, transparent);">
                  Feedback Source
                </label>
                <div class="relative">
                  <select
                    id="source"
                    name="source"
                    class="block w-full rounded-2xl border soft-divider px-3 py-2.5 pr-10 text-xs sm:text-sm outline-none"
                    style="background: color-mix(in srgb, var(--card) 85%, transparent); color: var(--text);"
                  >
                    <option>Discord</option>
                    <option>GitHub</option>
                    <option>X</option>
                    <option>Intercom</option>
                    <option>Other</option>
                  </select>
                  <div class="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                    <i data-lucide="chevron-down" class="w-3.5 h-3.5" style="color: var(--muted);"></i>
                  </div>
                </div>
              </div>

              <div class="space-y-2">
                <label for="content" class="block text-xs font-medium" style="color: color-mix(in srgb, var(--text) 78%, transparent);">
                  Raw Feedback
                </label>
                <textarea
                  id="content"
                  name="content"
                  rows="5"
                  placeholder="Example: The analytics dashboard feels slow when loading charts, and it's hard to find the right filters."
                  class="block w-full rounded-2xl border soft-divider px-3 py-2.5 text-xs sm:text-sm outline-none resize-none"
                  style="background: color-mix(in srgb, var(--card) 85%, transparent); color: var(--text);"
                  required
                ></textarea>
              </div>

              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 text-[11px]" style="color: var(--muted);">
                  <span class="inline-flex h-5 w-5 items-center justify-center rounded-full border soft-divider"
                        style="background: color-mix(in srgb, var(--cf-blue) 12%, transparent); color: color-mix(in srgb, var(--text) 80%, transparent);">
                    <i data-lucide="cpu" class="w-3 h-3"></i>
                  </span>
                  <span>Workers AI classifies sentiment &amp; theme before persisting to D1.</span>
                </div>
              </div>

              <div class="flex items-center gap-3">
                <button
                  id="analyze-button"
                  type="submit"
                  class="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-2.5 text-xs sm:text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60"
                  style="background: linear-gradient(135deg, #F38020, #FAAE40); box-shadow: 0 14px 35px color-mix(in srgb, #F38020 18%, transparent);"
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

              <p id="ingest-status" class="text-[11px] min-h-[1.25rem] pt-1" style="color: var(--muted);">
                Paste feedback, hit Analyze, then watch sentiment &amp; themes update.
              </p>
            </form>
          </aside>
        </div>
      </div>
    </main>

    <footer class="mt-auto border-t soft-divider">
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 text-xs sm:text-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2"
           style="color: var(--muted);">
        <span>Architected for reliability using Cloudflare Workflows &amp; D1 Database.</span>
        <span class="chip inline-flex items-center gap-2 rounded-full border soft-divider px-3 py-1"
              style="background: color-mix(in srgb, var(--card) 80%, transparent);">
          <span class="h-1.5 w-1.5 rounded-full" style="background: var(--cf-orange);"></span>
          Cloudflare Feedback Sentinel AI
        </span>
      </div>
    </footer>
  </div>

  <script>
    // State
    let themeChart;

    const THEME_KEY = "cfsentinel.theme";

    function setTheme(next) {
      const html = document.documentElement;
      html.setAttribute("data-theme", next);
      try { localStorage.setItem(THEME_KEY, next); } catch {}

      const label = document.getElementById("theme-label");
      const icon = document.getElementById("theme-icon");
      if (label) label.textContent = next === "light" ? "Light" : "Dark";
      if (icon) icon.setAttribute("data-lucide", next === "light" ? "sun" : "moon");
      if (window.lucide) window.lucide.createIcons();
    }

    function initTheme() {
      let saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch {}
      const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
      const initial = saved || (prefersLight ? "light" : "dark");
      setTheme(initial);
    }

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

    function isLightTheme() {
      return (document.documentElement.getAttribute("data-theme") || "dark") === "light";
    }

    // High-quality brand SVGs via SimpleIcons CDN (no inline SVG bloat).
    // Use high-contrast logos in light mode so they remain visible.
    function getSourceLogoUrl(source) {
      const color = isLightTheme() ? "0f172a" : "ffffff"; // slate-900 vs white
      const s = (source || "").toLowerCase();
      // SimpleIcons slugs: github, discord, x, intercom
      if (s.includes("github")) return "https://cdn.simpleicons.org/github/" + color;
      if (s.includes("discord")) return "https://cdn.simpleicons.org/discord/" + color;
      if (s === "x" || s.includes("twitter")) return "https://cdn.simpleicons.org/x/" + color;
      if (s.includes("intercom")) return "https://cdn.simpleicons.org/intercom/" + color;
      return "https://cdn.simpleicons.org/cloudflare/" + color;
    }

    function getStatus(row) {
      const sentiment = row.sentiment || "Neutral";
      const theme = row.theme || "";
      // Professional "console" status indicators.
      if (sentiment === "Negative" || theme === "Bug") {
        return { label: "Needs attention", tone: "rose" };
      }
      if (theme === "Feature Request" || sentiment === "Positive") {
        return { label: "Opportunity", tone: "blue" };
      }
      return { label: "Monitoring", tone: "slate" };
    }

    function statusChipClass(tone) {
      // Extra horizontal padding prevents label collision in table-fixed layouts.
      const base = "chip inline-flex items-center gap-2 rounded-full px-3 py-0.5 text-[11px] font-medium border";
      if (tone === "rose") return base + " border-rose-500/40 bg-rose-500/10 text-rose-200";
      if (tone === "blue") return base + " border-blue-500/40 bg-blue-500/10 text-blue-100";
      return base + " border-slate-500/35 bg-slate-500/10 text-slate-200";
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
      // Radar chart mapping the 4 themes (Bug, UI/UX, Performance, Feature Request)
      // with Cloudflare styling: orange border + semi-transparent indigo fill.
      const { themes, counts } = computeThemeStats(rows);

      const ordered = ["Bug", "UI/UX", "Performance", "Feature Request"];
      const data = ordered.map((t) => counts[t] || 0);
      const ctx = document.getElementById("themeChart").getContext("2d");
      if (themeChart) {
        themeChart.data.labels = ordered;
        themeChart.data.datasets[0].data = data;
        themeChart.update();
        return;
      }
      themeChart = new Chart(ctx, {
        type: "radar",
        data: {
          labels: ordered,
          datasets: [
            {
              label: "Intelligence Coverage",
              data,
              backgroundColor: "rgba(79, 70, 229, 0.22)", // indigo fill
              borderColor: "#F38020", // Cloudflare orange
              pointBackgroundColor: "#F38020",
              pointBorderColor: "#F38020",
              pointRadius: 3,
              pointHoverRadius: 4,
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              labels: {
                color: getComputedStyle(document.documentElement).getPropertyValue("--text") || "#0f172a",
                font: { size: 11 },
              },
            },
            tooltip: {
              backgroundColor: "rgba(26,26,26,0.95)",
              borderColor: "rgba(148,163,184,0.45)",
              borderWidth: 1,
              padding: 10,
              titleFont: { size: 11 },
              bodyFont: { size: 11 },
            },
          },
          scales: {
            r: {
              beginAtZero: true,
              ticks: {
                color: "rgba(148,163,184,0.75)",
                backdropColor: "transparent",
                precision: 0,
                font: { size: 10 },
              },
              angleLines: { color: "rgba(148,163,184,0.16)" },
              grid: { color: "rgba(148,163,184,0.14)" },
              pointLabels: {
                color: getComputedStyle(document.documentElement).getPropertyValue("--text") || "#0f172a",
                font: { size: 11, weight: "600" },
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
        tr.className = "transition";
        tr.style.borderTop = "1px solid color-mix(in srgb, var(--card-border) 45%, transparent)";
        tr.addEventListener("mouseenter", () => { tr.style.background = "color-mix(in srgb, var(--card) 80%, transparent)"; });
        tr.addEventListener("mouseleave", () => { tr.style.background = "transparent"; });

        const logoUrl = getSourceLogoUrl(row.source);
        const srcCell = document.createElement("td");
        srcCell.className = "px-3 sm:px-4 py-3 align-top text-xs sm:text-sm whitespace-nowrap";
        srcCell.innerHTML = \`
          <div class="flex items-center gap-2">
            <span class="inline-flex h-7 w-7 items-center justify-center rounded-full border soft-divider"
                  style="background: color-mix(in srgb, var(--card) 86%, transparent);">
              <img class="brand-logo" src="\${logoUrl}" alt="" width="14" height="14" />
            </span>
            <span class="max-w-[8rem] truncate" title="\${row.source || ""}" style="color: color-mix(in srgb, var(--text) 90%, transparent);">\${row.source || "Unknown"}</span>
          </div>
        \`;

        const contentCell = document.createElement("td");
        contentCell.className = "px-3 sm:px-4 py-3 align-top text-xs sm:text-sm";
        const safeContent = row.content || "";
        contentCell.innerHTML = \`
          <div class="truncate" title="\${safeContent.replace(/"/g, '&quot;')}" style="max-width: 100%; color: color-mix(in srgb, var(--text) 88%, transparent);">
            \${safeContent}
          </div>
        \`;

        const statusCell = document.createElement("td");
        statusCell.className = "px-3 sm:px-4 py-3 align-top text-xs sm:text-sm whitespace-nowrap";
        const status = getStatus(row);
        statusCell.innerHTML = \`
          <span class="\${statusChipClass(status.tone)}" title="Derived from sentiment + theme.">
            <span class="h-1.5 w-1.5 rounded-full" style="\${status.tone === "rose" ? "background:#fb7185" : status.tone === "blue" ? "background: var(--cf-blue)" : "background:#94a3b8"}"></span>
            \${status.label}
          </span>
        \`;

        const sentimentCell = document.createElement("td");
        sentimentCell.className = "px-3 sm:px-4 py-3 align-top text-xs sm:text-sm whitespace-nowrap";
        const sentiment = row.sentiment || "Neutral";
        sentimentCell.innerHTML = \`
          <span class="\${createSentimentPill(sentiment)}">
            \${sentiment}
          </span>
        \`;

        const themeCell = document.createElement("td");
        themeCell.className = "px-3 sm:px-4 py-3 align-top text-xs sm:text-sm whitespace-nowrap";
        const theme = row.theme || "Feature Request";
        themeCell.innerHTML = \`
          <span class="\${createThemePill(theme)}">
            \${theme}
          </span>
        \`;

        const whenCell = document.createElement("td");
        whenCell.className = "px-3 sm:px-4 py-3 align-top text-xs sm:text-sm whitespace-nowrap";
        whenCell.style.color = "var(--muted)";
        whenCell.textContent = formatRelativeTime(row.timestamp);

        tr.appendChild(srcCell);
        tr.appendChild(contentCell);
        tr.appendChild(statusCell);
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
      initTheme();
      const toggle = document.getElementById("theme-toggle");
      if (toggle) {
        toggle.addEventListener("click", () => {
          const current = document.documentElement.getAttribute("data-theme") || "dark";
          setTheme(current === "dark" ? "light" : "dark");
          // Chart colors depend on theme; recreate chart for perfect contrast.
          if (themeChart) { themeChart.destroy(); themeChart = null; }
          refreshDashboard({ silent: true });
        });
      }
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
