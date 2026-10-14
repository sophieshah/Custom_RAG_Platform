"""JSON stdin/stdout bridge for the deterministic rule engine."""

from __future__ import annotations

from dataclasses import asdict
import json
import sys

from tb_isolation_rules import evaluate, parse_inputs


def main() -> int:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict) or request.get("action") not in ("validate", "evaluate"):
            raise ValueError("action must be 'validate' or 'evaluate'")

        case = parse_inputs(request.get("case"))
        result = {"case": asdict(case)}
        if request["action"] == "evaluate":
            result["result"] = evaluate(case)

        json.dump(result, sys.stdout, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0
    except (ValueError, TypeError, json.JSONDecodeError) as error:
        print(f"Case validation failed: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"Rule engine failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
