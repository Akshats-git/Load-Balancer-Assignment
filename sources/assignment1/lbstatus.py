# Renders /lb/status as one readable line per backend.
import json, sys

data = json.load(sys.stdin)
for b in data["backends"]:
    print(f"  {b['url']:26} alive={str(b['alive']):5} served={b['served']}")
