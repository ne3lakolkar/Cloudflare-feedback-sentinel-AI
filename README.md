# 🛰️ Cloudflare Feedback Sentinel AI
**Transforming global feedback noise into actionable product intelligence.**



## 📖 Overview
Product feedback currently flows in from many scattered places every day—Discord, GitHub, X, and Support tickets—all making it difficult to extract value and sentiment. This results in significant "Invisible Labour" for Product Managers who must manually aggregate and categorize data before they can act on it.

**Feedback Sentinel AI** is a stateful intelligence pipeline designed to automate this aggregation. By orchestrating Cloudflare's Developer Platform, this prototype transforms high-volume noise into a high-fidelity dashboard that helps PMs prioritize what to build next.

---

## 🏗️ Architecture & Cloudflare Stack
This solution is architected as a reliable, stateful pipeline using four integrated Cloudflare products:

* **Cloudflare Workers:** Hosted the high-fidelity ingestion gateway and the dual-theme dashboard.
* **Cloudflare Workflows:** Orchestrated the "Receive → Analyze → Persist" pipeline to ensure stateful reliability and fault tolerance. I chose Workflows specifically for their stateful retry logic, ensuring zero data loss during the analysis phase.
* **Workers AI:** Leveraged Llama 3 for zero-shot sentiment and theme extraction from noisy strings.
* **D1 Database:** Served as the serverless SQL "System of Record" for all analyzed intelligence.

---

## ✨ Key Features
* **Intelligence Coverage:** A high-fidelity Radar Chart for real-time trend visualization and prioritization.
* **Sentiment Glance:** Instant visibility into user feeling across all feedback channels.
* **Sentinel Pulse:** Real-time visual status ("Sentinel active") confirming the health of the automated pipeline.
* **Simulated Ingest:** An interactive console to demonstrate the end-to-end flow from raw text to structured record.
* **Adaptive UX:** A pixel-perfect, dual-theme interface designed with HCI principles for maximum scannability.



---

## 📝 Product Insights (Friction Log)
A core part of this assignment involved identifying friction points in the Cloudflare developer experience. My submission includes a 5-point Friction Log detailing:
1. **CLI Shell-Escape Collision:** Friction with ZSH/Fish shell globbing.
2. **The "Success" Propagation Gap:** The UX delay between CLI success and global SSL readiness.
3. **Workers AI Schema Drift:** The need for Typed AI Responses in stateful pipelines.
4. **Workflow Observability:** The "Black Box" nature of stateful instances.
5. **Redundant Binding Boilerplate:** The friction of manual type declarations.

---

## 🛠️ Setup & Deployment
1. **Clone the repository:**
   ```bash
   git clone [https://github.com/ne3lakolkar/Cloudflare-feedback-sentinel-AI](https://github.com/ne3lakolkar/Cloudflare-feedback-sentinel-AI)
