"""Local-only LLM calls (Ollama) - the one deliberate exception to this
app's own "less LLM, more code" rule (Ayush, 29 Sep), reserved for the
handful of things genuinely infeasible without one: deciding which project
a transcript belongs to, and the Diarize / Generate Transcript buttons on
the Transcripts detail page.

Runs against a local Ollama install (http://localhost:11434) only - never
an external API. This is a direct response to Venki's own stated concern
in the 30 Sep "Orient-Me / Shared Context Project Meeting" recording:
"let that be a local kind of thing... it's not [like] all transcript
should go out." No API key, no network call leaves this machine, and
nothing here depends on Settings.llm_api_key/llm_base_url (those remain
OpenRouter-based and are used elsewhere in this app, e.g. task drafting -
deliberately untouched, since Venki's concern was specifically about
transcript content).
"""

import logging

import httpx

logger = logging.getLogger(__name__)

OLLAMA_URL = "http://localhost:11434"
# 3b, not a bigger model: qwen2.5:7b was tried first for better instruction
# following, but on this machine's CPU-only Ollama it couldn't finish a
# real ~9,000-character transcript inside even a 4-minute timeout - not
# viable for an on-demand button click. The fix isn't a bigger model, it's
# forcing structured JSON output (the `schema` param below, Ollama's
# format-as-JSON-Schema support, confirmed on the installed 0.34.4) - a 3b
# model reliably fills a constrained schema even when it can't reliably
# free-write a markdown template, and it does it fast.
OLLAMA_MODEL = "qwen2.5:3b"


def call_local_llm(prompt, timeout=180, schema=None, temperature=0.1):
    """Returns the model's raw text response (or, with `schema`, a JSON
    string matching it - json.loads it yourself), or None if Ollama isn't
    reachable/installed. Every caller treats None as "skip this, fall back
    to the honest no-LLM behavior" - never a crash, same graceful-fallback
    convention as every other LLM call in this app.

    Low temperature by default (not Ollama's own default of 0.8) - every
    caller here extracts/labels real transcript content, never writes
    anything creative, and a real test on 30 Sep showed the default
    temperature let the 3b model hallucinate a fabricated speaker
    ("Claude") and an invented line of dialogue that was never said."""
    payload = {
        "model": OLLAMA_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": temperature},
    }
    if schema is not None:
        payload["format"] = schema
    try:
        response = httpx.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=timeout)
        response.raise_for_status()
        return response.json()["message"]["content"]
    except Exception:  # noqa: BLE001 - local model unavailable is a normal, expected state
        logger.exception("Local LLM (Ollama) call failed - is `ollama serve` running with %s pulled?", OLLAMA_MODEL)
        return None
