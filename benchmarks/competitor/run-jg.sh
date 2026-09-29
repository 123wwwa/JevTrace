#!/usr/bin/env bash
# Runs inside the jevgrep container: one cold `jg` search per case and configuration.
# Inputs: /bench/cases.tsv (id<TAB>root<TAB>task), OPENROUTER_API_KEY. Outputs: /out/<config>/<id>.{txt,usage.jsonl,meta.json}
set -uo pipefail
printf '%s' "$OPENROUTER_API_KEY" | jg auth --provider openrouter --stdin >/dev/null
export NODE_OPTIONS="--import /bench/probe.mjs"
# Bind mounts from a Windows host make file I/O much slower than native disk; copy the read-only
# checkouts onto the container's own filesystem so timings compare with JevTrace's native runs.
mkdir -p /work && cp -a /repos/. /work/

run() { # config-name, extra jg flags...
  local config="$1"; shift
  mkdir -p "/out/$config"
  while IFS=$'\t' read -r id root task; do
    [ -z "$id" ] && continue
    root="/work/${root#/repos/}"
    rm -f "/out/$config/$id.usage.jsonl"
    local start end code
    start=$(date +%s%N)
    JEVGREP_PROBE_OUT="/out/$config/$id.usage.jsonl" jg --no-cache "$@" "$task" "$root" > "/out/$config/$id.txt" 2> "/out/$config/$id.stderr"
    code=$?
    end=$(date +%s%N)
    printf '{"exit":%d,"ms":%d}\n' "$code" $(( (end - start) / 1000000 )) > "/out/$config/$id.meta.json"
    echo "$config $id exit=$code $(( (end - start) / 1000000 ))ms" >&2
  done < /bench/cases.tsv
}

for config in ${JG_CONFIGS:-default budget-32kb}; do
  case "$config" in
    default) run default ;;
    budget-32kb) run budget-32kb --max-source-bytes 32000 ;;
  esac
done
