"""Validate and print published measurements without private logs or network access."""
import csv
import hashlib
import json
import statistics
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def read(name):
    return json.loads((ROOT / name).read_text())

with (ROOT / "measurements.csv").open() as source:
    rows = list(csv.DictReader(source))
assert len(rows) == 144
assert Counter(Counter((r["workload"], r["path"], r["state"]) for r in rows).values()) == {3: 48}
assert sum(r["correct"].lower() == "true" for r in rows) == 142
workloads = read("workloads.json")
for task in workloads:
    assert hashlib.sha256(task["prompt"].encode()).hexdigest() == task["sha256"]
groups = read("text-ttft.json")["groups"]
for g in groups:
    selected = [r for r in rows if all(r[k] == g[k] for k in ("workload", "path", "state"))]
    metric = "run_first_text_ms" if g["path"] == "nanocodex" else "ttft_ms"
    values = [float(r[metric]) for r in selected]
    assert len(values) == g["n"]
    for key, value in (("median_ms", statistics.median(values)), ("min_ms", min(values)), ("max_ms", max(values))):
        assert abs(value - g[key]) < 1e-6
print("Text TTFT seconds: first prompt / repeat (see report for differing boundaries)")
print("| Workload | Hosted | Agents API | Codex CLI | Native CLI |")
print("| --- | ---: | ---: | ---: | ---: |")
for task in workloads:
    cells = []
    for path in ("hosted", "agents", "codex", "nanocodex"):
        cells.append(" / ".join(f"{next(g['median_ms'] for g in groups if g['workload'] == task['id'] and g['path'] == path and g['state'] == state) / 1000:.2f}" for state in ("fresh_session", "followup")))
    print("| " + task["id"] + " | " + " | ".join(cells) + " |")
voice = read("voice-summary.json")
assert len(voice["rows"]) == 6 and all(r["correct"] for r in voice["rows"])
for r in voice["rows"]:
    assert abs(r["first_audio_from_speech_start_ms"] - r["input_duration_ms"] - r["response_after_speech_end_ms"]) < 1e-6
print("\nVoice median seconds: readiness / response after speech ends")
for kind in ("codex", "nanocodex"):
    selected = [r for r in voice["rows"] if r["kind"] == kind]
    assert len(selected) == 3
    for metric in ("ready_ms", "response_after_speech_end_ms", "call_ms"):
        values = [r[metric] for r in selected]
        assert abs(statistics.median(values) - voice["groups"][kind][metric]["median"]) < 1e-6
    print(kind, " / ".join(f"{statistics.median(r[k] for r in selected) / 1000:.3f}" for k in ("ready_ms", "response_after_speech_end_ms")))
print("\nPublished measurement checks passed.")
