"""AI Health Analyst.

A tool-calling agent that answers natural-language questions by running
read-only SQL against the local Oura database.

Design notes
------------
* The database is opened READ-ONLY (SQLite ``mode=ro``), so a hallucinated
  ``DELETE`` can never damage the user's data.
* The model is configurable: a local Ollama server (default, fully offline)
  or any OpenAI-compatible endpoint (LM Studio, llama.cpp server, OpenRouter,
  OpenAI itself).  Nothing is sent anywhere unless the user configures a
  remote endpoint.
* Conversation history is passed to the model so follow-up questions work.
* ``chat`` is synchronous and CPU/network bound; callers must run it in a
  worker thread (see ``routes.py``) so the API event loop is never blocked.
"""

from __future__ import annotations

import logging
import os
from datetime import date
from typing import Any, Dict, List, Optional

from backend.src.config import config_manager
from backend.src.database import DB_PATH

logger = logging.getLogger("DataAnalyst")

DEFAULT_OLLAMA_HOST = "http://localhost:11434"
DEFAULT_OLLAMA_MODEL = "llama3.1:latest"

SCHEMA_NOTES = """
TABLES (SQLite). Daily summaries are keyed by `day` (YYYY-MM-DD text):
- sleep: THE daily sleep score. columns day, score (0-100), contributors JSON, average_spo2, breathing_disturbance_index, recommendation, status
- readiness: THE daily readiness score. columns day, score, temperature_deviation (°C vs baseline), temperature_trend_deviation, contributors JSON, stress_high, recovery_high, day_summary
- activity: THE daily activity score. columns day, score, steps, total_calories, active_calories, average_met, high_activity_time, medium_activity_time, low_activity_time, sedentary_time, resting_time, non_wear_time, contributors JSON
- resilience: day, level, sleep_recovery, daytime_recovery, stress
- sleep_session: one row per sleep period (NOT the score). columns day, type ('long_sleep' = main night), bedtime_start, bedtime_end, total_sleep_duration, deep_sleep_duration, rem_sleep_duration, light_sleep_duration, awake_time, latency, efficiency, average_heart_rate, lowest_heart_rate, average_hrv, average_breath, time_in_bed, restless_periods
- workout: day, start_time, end_time, activity, calories, distance, intensity, label
- meditation: day, start_time, end_time, type, mood
- heart_rate: timestamp, bpm, source (all-day samples)
- temperature: timestamp, skin_temp
- ring_battery: timestamp, level, charging
- cardiovascular_age: day, vascular_age
- vo2max: day, vo2_max
- tag: start_time, end_time, tag_type_code, comment
- live_session: recorded live sessions from the ring. columns id, kind ('steadiness','workout','breathing','orthostatic','free'), simulated (1 = synthetic test), started_at, duration_s, metrics JSON (json_extract(metrics,'$.tremor.steadiness_score'), '$.tremor.dominant_hz', '$.motion.activity', '$.hrv.rmssd_ms', '$.breathing.resonance', '$.orthostatic.delta_stand'), notes
RULES: durations are SECONDS (divide by 3600 for hours). Scores live ONLY in sleep/readiness/activity.
"Last 7 days of data" means the 7 most recent days present in the table (ORDER BY day DESC LIMIT 7), not relative to today unless asked.
JSON keys: json_extract(contributors, '$.deep_sleep'). Always use ORDER BY / LIMIT and aliases; keep queries simple.
"""


def _build_llm(cfg: Dict[str, Any]):
    provider = (cfg.get("llm_provider") or "ollama").lower()
    model = cfg.get("llm_model") or DEFAULT_OLLAMA_MODEL
    if provider in ("openai", "openai_compatible", "openai-compatible"):
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            base_url=cfg.get("llm_base_url") or None,
            api_key=cfg.get("llm_api_key") or "not-set",
            model=model,
            temperature=0,
        )
    from langchain_ollama import ChatOllama

    return ChatOllama(
        base_url=cfg.get("llm_host") or DEFAULT_OLLAMA_HOST,
        model=model,
        temperature=0,
    )


def _read_only_db():
    from langchain_community.utilities import SQLDatabase

    if not os.path.exists(DB_PATH):
        raise FileNotFoundError("No database yet. Import your Oura data first.")
    # SQLite URI form so we can pass mode=ro (the file must already exist).
    uri = f"sqlite:///file:{DB_PATH}?mode=ro&uri=true"
    return SQLDatabase.from_uri(uri, sample_rows_in_table_info=2)


def _to_lc_messages(history: List[Dict[str, str]]):
    from langchain_core.messages import AIMessage, HumanMessage

    out = []
    for m in history:
        role = (m.get("role") or "user").lower()
        content = m.get("content") or ""
        if not content:
            continue
        out.append(AIMessage(content) if role == "assistant" else HumanMessage(content))
    return out


class DataAnalyst:
    """One instance per request is fine; construction is cheap."""

    def __init__(self, cfg: Optional[Dict[str, Any]] = None):
        self.cfg = cfg or config_manager.get_config()
        today = date.today().isoformat()
        self.system_prompt = (
            "You are an expert analyst of the user's own Oura Ring data stored in a local SQLite database. "
            f"Today is {today}. Always inspect the schema or run sql_db_query with SELECT statements to get real numbers; "
            "never invent values. Use the table list below; do not call sql_db_list_tables or sql_db_schema unless a query fails. Prefer aggregate queries with clear column aliases. Round results sensibly, "
            "convert seconds to hours/minutes for durations, and explain briefly what the numbers mean for the user. "
            "If the database has no rows for the period, say so plainly.\n" + SCHEMA_NOTES
        )

    def chat(self, history: List[Dict[str, str]], max_history: int = 12) -> Dict[str, Any]:
        """Run the agent for the latest user message with prior turns as context."""
        history = [m for m in history if m.get("content")]
        if not history:
            return {"response": "Ask me a question about your data.", "thoughts": []}

        thoughts: List[Dict[str, Any]] = []
        try:
            from langchain.agents import create_agent
            from langchain_community.agent_toolkits import SQLDatabaseToolkit

            llm = _build_llm(self.cfg)
            db = _read_only_db()
            tools = SQLDatabaseToolkit(db=db, llm=llm).get_tools()
            agent = create_agent(llm, tools, system_prompt=self.system_prompt)

            messages = _to_lc_messages(history[-max_history:])
            result = agent.invoke({"messages": messages}, config={"recursion_limit": 40})

            final = ""
            step = 0
            for msg in result.get("messages", []):
                mtype = getattr(msg, "type", "")
                if mtype == "ai":
                    calls = getattr(msg, "tool_calls", None) or []
                    for call in calls:
                        step += 1
                        thoughts.append(
                            {
                                "step": step,
                                "type": "tool_call",
                                "tool": call.get("name"),
                                "params": call.get("args"),
                                "content": str(call.get("args")),
                            }
                        )
                    if not calls and msg.content:
                        final = msg.content if isinstance(msg.content, str) else str(msg.content)
                elif mtype == "tool":
                    step += 1
                    thoughts.append(
                        {
                            "step": step,
                            "type": "tool_result",
                            "tool": getattr(msg, "name", None),
                            "content": msg.content if isinstance(msg.content, str) else str(msg.content),
                        }
                    )

            if not final:
                final = "I ran the analysis but could not produce a final answer. Try rephrasing the question."
            return {"response": final, "thoughts": thoughts}

        except Exception as e:  # surfaced to the UI on purpose
            logger.exception("Agent error")
            text = str(e)
            hint = ""
            lowered = text.lower()
            if "connect" in lowered and ("11434" in text or "refused" in lowered):
                hint = " (Is Ollama running? Configure the LLM host/model in Settings → AI Analyst.)"
            elif "does not support tools" in lowered:
                hint = " (This model cannot call tools. Pick a tool-capable model such as llama3.1, llama3.2, qwen2.5 or mistral-nemo.)"
            elif "not found" in lowered and "model" in lowered:
                hint = " (Pull the model first, e.g. `ollama pull llama3.2:3b`, or pick another in Settings.)"
            return {
                "response": f"I encountered an error: {text}{hint}",
                "thoughts": thoughts + [{"step": 99, "type": "error", "content": text}],
            }


def check_llm_connection(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Cheap connectivity probe used by the Settings UI."""
    cfg = cfg or config_manager.get_config()
    provider = (cfg.get("llm_provider") or "ollama").lower()
    wanted = cfg.get("llm_model") or DEFAULT_OLLAMA_MODEL
    try:
        if provider == "ollama":
            import httpx

            host = (cfg.get("llm_host") or DEFAULT_OLLAMA_HOST).rstrip("/")
            r = httpx.get(f"{host}/api/tags", timeout=4.0)
            r.raise_for_status()
            models = [m.get("name") for m in r.json().get("models", [])]
            available = any(m == wanted or m.split(":")[0] == wanted.split(":")[0] for m in models)
            return {"ok": True, "provider": "ollama", "models": models, "model": wanted, "model_available": available}
        llm = _build_llm(cfg)
        llm.invoke("Reply with the single word OK.")
        return {"ok": True, "provider": provider, "models": [], "model": wanted, "model_available": True}
    except Exception as e:
        return {"ok": False, "provider": provider, "model": wanted, "error": str(e)}
