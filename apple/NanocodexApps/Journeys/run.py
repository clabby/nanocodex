#!/usr/bin/env python3
"""Black-box journeys against native-app-journey; fixtures are actual Swift apps."""
import argparse
import json
import pathlib
import subprocess
import shutil
import time

parser = argparse.ArgumentParser()
parser.add_argument('--binary', required=True)
parser.add_argument('--output', required=True)
a = parser.parse_args()
binary = str(pathlib.Path(a.binary).resolve())
out = pathlib.Path(a.output).resolve()
out.mkdir(parents=True, exist_ok=True)
fixtures = pathlib.Path(__file__).resolve().parent
checks = 0
for fixture in fixtures.glob("*.swift"):
    shutil.copy2(fixture, out / fixture.name)
shutil.copy2(__file__, out / "run.py")


def run(app, name, operations=(), *, seed=None, expected=None, visible=(), absent=(), agent=None, fail=None):
    global checks
    state = out / (app + '.json')
    if seed is not None:
        state.write_text(json.dumps(seed))
    command = [binary, '--source', str(fixtures / (app + '.swift')), '--state', str(state)]
    if agent:
        command += ['--agent-response', agent]
    for op in operations:
        command += ['--set', op[1], json.dumps(op[2])] if op[0] == 'set' else ['--action', op[1]]
    (out / (name + ".command.json")).write_text(json.dumps(command, indent=2))
    result = subprocess.run(command, text=True, capture_output=True)
    text = result.stdout + result.stderr
    (out / (name + '.log')).write_text(text)
    if fail:
        assert result.returncode != 0 and fail in text, (name, text[-2000:])
    else:
        assert result.returncode == 0, (name, text[-2000:])
    # Only the final screen is asserted, not stale prior render output.
    final = text.rsplit('TRACE ', 1)[-1].replace('\\/', '/')
    for phrase in visible:
        assert phrase in final, (name, phrase, final)
    for phrase in absent:
        assert phrase not in final, (name, phrase, final)
    saved = json.loads(state.read_text())
    for key, value in (expected or {}).items():
        assert saved.get(key) == value, (name, key, saved.get(key), value)
    checks += 1
    print('PASS', name)
    return saved, text


# Independent generation holdouts: authored from AUTHORING.md, not the implementation.
# The unknown key must survive every source-driven storage write.
started = time.time()
smoke, _ = run('cigarette-tracker', 'smoke-log-and-undo', [
    ('set', 'packPrice', '10.00'), ('action', 'Log a cigarette'),
    ('action', 'Log a cigarette'), ('action', 'Undo latest cigarette')],
    seed={'future-key': {'preserved': True}}, expected={'smoke.pack.price': '10.00', 'future-key': {'preserved': True}},
    visible=['Today: 0.5', 'Past seven days: 0.5'])
records = smoke['smoke.entries']
assert len(records) == 1 and records[0]['id'] and started <= records[0]['timestamp'] <= time.time()
run('cigarette-tracker', 'smoke-reopen', visible=['Today: 0.5'])
run('cigarette-tracker', 'smoke-invalid-price-and-empty', [
    ('set', 'packPrice', 'not a price'), ('action', 'Undo latest cigarette')],
    expected={'smoke.entries': []}, visible=['Enter a nonnegative pack price', 'Today: 0'])
run('cigarette-tracker', 'smoke-disabled-undo', [('action', 'Undo latest cigarette')], fail='is disabled')
run('cigarette-tracker', 'smoke-historical', seed={'smoke.entries': [{'id': 'historic', 'timestamp': 0}]},
    expected={'smoke.entries': [{'id': 'historic', 'timestamp': 0}]}, visible=['Today: 0', 'Past seven days: 0'])

run('calorie-tracker', 'meal-invalid-input', [('set', 'mealName', 'Toast'), ('set', 'calorieInput', 'oops'),
    ('action', 'Log meal')], seed={}, fail='is disabled', visible=['Enter a positive whole number'])
meals, _ = run('calorie-tracker', 'meals-log-and-undo', [
    ('set', 'calorieGoal', 2200), ('set', 'mealName', 'Porridge and berries'), ('set', 'calorieInput', '450'),
    ('action', 'Log meal'), ('set', 'mealName', 'Lentil soup'), ('set', 'calorieInput', '350'),
    ('action', 'Log meal'), ('action', 'Undo latest meal')], seed={}, expected={'meals.goal': 2200},
    visible=['1750 kcal remaining', 'Porridge and berries', '450 kcal'], absent=['Text "Lentil soup"'])
assert len(meals['meals.log']) == 1 and meals['meals.log'][0]['calories'] == 450
run('calorie-tracker', 'meals-reopen', visible=['1750 kcal remaining', 'Porridge and berries'])
response = 'Approximately 450 kcal; portions affect this estimate.'
agent_state, trace = run('calorie-tracker', 'meals-agent-and-edit', [
    ('set', 'mealDescription', 'Lentil soup and bread'), ('action', 'Ask for an estimate'),
    ('set', 'advice', 'My portion was smaller: about 320 kcal.')], agent=response,
    visible=['My portion was smaller: about 320 kcal.'])
assert trace.count('HOST Agent.run prompt=') == 1 and 'Do not prescribe a calorie target' in trace
assert agent_state == meals  # Estimates and draft text never add records or write persisted state.
run('calorie-tracker', 'meals-agent-reopen', visible=['1750 kcal remaining', 'TextEditor "" binding=advice value=""'])
run('calorie-tracker', 'meals-historical', seed={'meals.log': [{'id': 'old', 'name': 'Old breakfast', 'calories': 600, 'timestamp': 0}]},
    visible=['Old breakfast', '2000 kcal remaining'])
run('calorie-tracker', 'meals-over-goal', [('set', 'calorieGoal', 500), ('set', 'mealName', 'Dinner'),
    ('set', 'calorieInput', '650'), ('action', 'Log meal')], seed={}, visible=['150 kcal above your chosen goal'])

packed, _ = run('packing-checklist', 'packing-add-and-complete', [
    ('set', 'tripName', 'A weekend in Lisbon'), ('set', 'newItem', 'Passport'), ('action', 'Add to packing list'),
    ('set', 'newItem', 'Phone charger'), ('action', 'Add to packing list'),
    ('action', 'Pack: Passport'), ('action', 'Pack: Phone charger')], seed={},
    expected={'packing.trip': 'A weekend in Lisbon', 'packing.items': ['Passport', 'Phone charger'], 'packing.packed': ['Passport', 'Phone charger']},
    visible=['2 / 2', 'Everything is in. Enjoy the journey!'])
run('packing-checklist', 'packing-reopen', expected=packed, visible=['Everything is in. Enjoy the journey!'])
run('packing-checklist', 'packing-duplicate', [('set', 'newItem', 'Passport'), ('action', 'Add to packing list')],
    fail='is disabled', expected=packed, visible=['That item is already on your list.'])
run('packing-checklist', 'packing-unpack', [('action', 'Unpack: Passport')],
    expected={'packing.packed': ['Phone charger']}, visible=['1 / 2', 'Pack: Passport'])
run('packing-checklist', 'packing-reset-and-reopen', [('action', 'Mark everything unpacked')],
    expected={'packing.packed': []}, visible=['0 / 2'])
run('packing-checklist', 'packing-final-reopen', expected={'packing.packed': [], 'packing.items': ['Passport', 'Phone charger']}, visible=['0 / 2'])
# Large histories keep all records, while the journal renders a recent window.
old_smoke = [{'id': f'smoke-{i}', 'timestamp': i * 3600} for i in range(1000)]
large_smoke, _ = run('cigarette-tracker', 'smoke-1000-records', [('action', 'Log a cigarette')],
    seed={'smoke.entries': old_smoke}, visible=['Today: 0.6'])
assert len(large_smoke['smoke.entries']) == 1001 and large_smoke['smoke.entries'][:1000] == old_smoke
run('cigarette-tracker', 'smoke-1000-reopen-and-undo', [('action', 'Undo latest cigarette')],
    expected={'smoke.entries': old_smoke}, visible=['Today: 0'])
old_meals = [{'id': f'meal-{i}', 'name': f'Historic meal {i}', 'calories': 300, 'timestamp': i * 3600} for i in range(1000)]
large_meals, _ = run('calorie-tracker', 'meals-1000-records', [('set', 'mealName', 'Lunch'),
    ('set', 'calorieInput', '450'), ('action', 'Log meal')], seed={'meals.log': old_meals},
    visible=['1550 kcal remaining', 'Showing your latest 30 meals', 'Historic meal 999'], absent=['Text "Historic meal 0"'])
assert len(large_meals['meals.log']) == 1001 and large_meals['meals.log'][:1000] == old_meals
run('calorie-tracker', 'meals-1000-reopen', visible=['1550 kcal remaining', 'Lunch'])
print(f'PASS {checks} public CLI journeys; evidence={out}')
