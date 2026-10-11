// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { acceptedGlobals, GLOBAL_OPTIONS, type CommandSpec, type OptionSpec, type Registry } from "./registry.js";

const PROFILES_WORD = "@profiles";

/** Prints a position-aware script built from the registry. It never calls the network or the executable (STYLE-COMP-2). */
export function completionScript(registry: Registry, shell: string): string {
  const fish = shell === "fish";
  const script = shell === "zsh" ? zshScript(registry.bin) : fish ? fishScript(registry.bin) : bashScript(registry.bin);
  const commands = orderedCommands(registry);
  const escape = (item: string): string => (fish ? item.replaceAll("\\", "\\\\").replaceAll("'", "\\'") : item.replaceAll("'", "'\\''"));
  const list = (items: string[]): string => (fish ? items.map((item) => `'${escape(item)}'`).join(" ") : items.map(escape).join("\n"));
  const valueOptions = valueOptionNames(registry);
  const replacements: Record<string, string> = {
    __TABLE__: list(commandLines(commands)),
    __POSITIONALS__: list(positionalLines(commands)),
    __VALUES__: list(valueLines(registry)),
    __VALUE_OPTIONS__: fish ? list(valueOptions) : ` ${valueOptions.join(" ")} `,
    __ROOT_OPTIONS__: fish ? list(rootOptionNames()) : rootOptionNames().join(" "),
  };
  return Object.entries(replacements).reduce((text, [token, value]) => text.split(token).join(value), script);
}

function spellings(option: OptionSpec): string[] {
  return [`--${option.name}`, ...(option.short ? [`-${option.short}`] : [])];
}

function rootOptionNames(): string[] {
  return acceptedGlobals("root").flatMap(spellings);
}

function orderedCommands(registry: Registry): CommandSpec[] {
  return registry.rootOrder().flatMap((word) => registry.under([word]));
}

function commandLines(commands: CommandSpec[]): string[] {
  return commands.map((spec) => {
    const options = [...spec.options, ...acceptedGlobals(spec.kind)].flatMap(spellings);
    return `${spec.path.join(" ")}|${options.join(" ")}`;
  });
}

function positionalLines(commands: CommandSpec[]): string[] {
  return commands.flatMap((spec) =>
    spec.arguments.flatMap((argument, index) => {
      const values = argument.choices ?? (argument.completion === "profiles" ? [PROFILES_WORD] : undefined);
      return values ? [`${spec.path.join(" ")}|${index}|${values.join(" ")}`] : [];
    }),
  );
}

function allOptions(registry: Registry): OptionSpec[] {
  return [...registry.commands.flatMap((spec) => spec.options), ...GLOBAL_OPTIONS];
}

/** One line per option with allowed values: the command path (or * for a global option), the option, and its values. */
function valueLines(registry: Registry): string[] {
  const own = registry.commands.flatMap((spec) =>
    spec.options
      .filter((option) => option.choices)
      .map((option) => `${spec.path.join(" ")}|--${option.name}|${(option.choices ?? []).join(" ")}`),
  );
  const global = GLOBAL_OPTIONS.filter((option) => option.choices).map((option) => `*|--${option.name}|${(option.choices ?? []).join(" ")}`);
  return [...own, ...global];
}

function valueOptionNames(registry: Registry): string[] {
  const names = allOptions(registry)
    .filter((option) => option.type !== "boolean")
    .map((option) => `--${option.name}`);
  return [...new Set(names)];
}

function bashScript(bin: string): string {
  return `# bash completion for ${bin}
_${bin}_table='__TABLE__'
_${bin}_positionals='__POSITIONALS__'
_${bin}_values='__VALUES__'
_${bin}_value_options='__VALUE_OPTIONS__'
_${bin}_root_options='__ROOT_OPTIONS__'

_${bin}_profiles() {
  local dir="\${XDG_CONFIG_HOME:-}" file name
  case "$dir" in /*) ;; *) dir="$HOME/.config" ;; esac
  for file in "$dir"/${bin}/profiles/*.json; do
    [ -e "$file" ] || continue
    name="\${file##*/}"
    name="\${name%.json}"
    case "$name" in ""|.|..|*[!A-Za-z0-9._-]*) continue ;; esac
    echo "$name"
  done
}

_${bin}_values_for() {
  local line scope rest option found=""
  while IFS= read -r line; do
    scope="\${line%%|*}"
    rest="\${line#*|}"
    option="\${rest%%|*}"
    [ "$option" = "$2" ] || continue
    if [ "$scope" = "$1" ]; then
      echo "\${rest#*|}"
      return 0
    fi
    if [ "$scope" = "*" ]; then found="\${rest#*|}"; fi
  done <<< "$_${bin}_values"
  echo "$found"
}

_${bin}_complete() {
  local cur prev prefix word line cmd opts candidates values i j ok match matchcmd matchlen next
  local -a words parts
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev=""
  if [ "$COMP_CWORD" -gt 1 ]; then prev="\${COMP_WORDS[COMP_CWORD-1]}"; fi
  if [ "$cur" = "=" ]; then
    cur=""
  elif [ "$prev" = "=" ] && [ "$COMP_CWORD" -gt 2 ]; then
    prev="\${COMP_WORDS[COMP_CWORD-2]}"
  fi
  prefix=""
  case "$cur" in
    --*=*) prev="\${cur%%=*}"; prefix="$prev="; cur="\${cur#*=}" ;;
  esac
  COMPREPLY=()
  for ((i = 1; i < COMP_CWORD; i++)); do
    if [ "\${COMP_WORDS[$i]}" = "--" ]; then return 0; fi
  done
  words=()
  i=1
  while [ "$i" -lt "$COMP_CWORD" ]; do
    word="\${COMP_WORDS[$i]}"
    case "$word" in
      --*=*) ;;
      -*)
        case "$_${bin}_value_options" in
          *" $word "*)
            if [ "\${COMP_WORDS[$((i + 1))]}" = "=" ]; then i=$((i + 2)); else i=$((i + 1)); fi
            ;;
        esac
        ;;
      *) words[\${#words[@]}]="$word" ;;
    esac
    i=$((i + 1))
  done
  match=""
  matchcmd=""
  matchlen=0
  next=""
  while IFS= read -r line; do
    cmd="\${line%%|*}"
    opts="\${line#*|}"
    parts=($cmd)
    ok=1
    if [ "\${#words[@]}" -ge "\${#parts[@]}" ]; then
      for ((j = 0; j < \${#parts[@]}; j++)); do
        [ "\${words[$j]}" = "\${parts[$j]}" ] || ok=0
      done
      if [ "$ok" = 1 ]; then match="$opts"; matchcmd="$cmd"; matchlen="\${#parts[@]}"; break; fi
    else
      for ((j = 0; j < \${#words[@]}; j++)); do
        [ "\${words[$j]}" = "\${parts[$j]}" ] || ok=0
      done
      if [ "$ok" = 1 ]; then
        word="\${parts[\${#words[@]}]}"
        case " $next " in *" $word "*) ;; *) next="$next $word" ;; esac
      fi
    fi
  done <<< "$_${bin}_table"
  case "$_${bin}_value_options" in
    *" $prev "*)
      candidates=""
      if [ "$prev" = "--profile" ]; then
        candidates="$(_${bin}_profiles)"
      else
        candidates="$(_${bin}_values_for "$matchcmd" "$prev")"
      fi
      COMPREPLY=($(compgen -P "$prefix" -W "$candidates" -- "$cur"))
      return 0
      ;;
  esac
  if [ -n "$match" ]; then
    candidates="$match"
    if [[ "$cur" != -* ]]; then
      values=""
      while IFS= read -r line; do
        case "$line" in
          "$matchcmd|$((\${#words[@]} - matchlen))|"*) values="\${line##*|}" ;;
        esac
      done <<< "$_${bin}_positionals"
      if [ -n "$values" ]; then candidates="\${values//${PROFILES_WORD}/$(_${bin}_profiles)}"; fi
    fi
  elif [ "\${#words[@]}" -eq 0 ] && [[ "$cur" == -* ]]; then
    candidates="$_${bin}_root_options"
  else
    candidates="$next"
  fi
  COMPREPLY=($(compgen -W "$candidates" -- "$cur"))
}

complete -F _${bin}_complete ${bin}
`;
}

function zshScript(bin: string): string {
  return `#compdef ${bin}
# zsh completion for ${bin}
_${bin}_table='__TABLE__'
_${bin}_positionals='__POSITIONALS__'
_${bin}_values='__VALUES__'
_${bin}_value_options='__VALUE_OPTIONS__'
_${bin}_root_options='__ROOT_OPTIONS__'

_${bin}_profiles() {
  local dir="\${XDG_CONFIG_HOME:-}" file name
  [[ "$dir" == /* ]] || dir="$HOME/.config"
  for file in "$dir"/${bin}/profiles/*.json(N); do
    name="\${\${file:t}%.json}"
    case "$name" in ""|.|..|*[!A-Za-z0-9._-]*) continue ;; esac
    print -r -- "$name"
  done
}

_${bin}_values_for() {
  local line scope rest option found=""
  for line in "\${(@f)_${bin}_values}"; do
    scope="\${line%%|*}"
    rest="\${line#*|}"
    option="\${rest%%|*}"
    [[ "$option" == "$2" ]] || continue
    if [[ "$scope" == "$1" ]]; then
      print -r -- "\${rest#*|}"
      return 0
    fi
    [[ "$scope" == "*" ]] && found="\${rest#*|}"
  done
  print -r -- "$found"
}

_${bin}() {
  local cur="\${words[CURRENT]}" prev="" word line cmd opts candidates values match="" matchcmd="" next=""
  local -a typed parts
  local i j ok matchlen=0
  for (( i = 2; i < CURRENT; i++ )); do
    [[ "\${words[i]}" == "--" ]] && return 0
  done
  (( CURRENT > 2 )) && prev="\${words[CURRENT-1]}"
  if [[ "$cur" == --*=* && "$_${bin}_value_options" == *" \${cur%%=*} "* ]]; then
    prev="\${cur%%=*}"
    compset -P '*='
  fi
  typed=()
  i=2
  while (( i < CURRENT )); do
    word="\${words[i]}"
    case "$word" in
      --*=*) ;;
      -*) [[ "$_${bin}_value_options" == *" $word "* ]] && (( i++ )) ;;
      *) typed+=("$word") ;;
    esac
    (( i++ ))
  done
  for line in "\${(@f)_${bin}_table}"; do
    cmd="\${line%%|*}"
    opts="\${line#*|}"
    parts=(\${=cmd})
    ok=1
    if (( \${#typed} >= \${#parts} )); then
      for (( j = 1; j <= \${#parts}; j++ )); do
        [[ "\${typed[j]}" == "\${parts[j]}" ]] || ok=0
      done
      if (( ok )); then match="$opts"; matchcmd="$cmd"; matchlen=\${#parts}; break; fi
    else
      for (( j = 1; j <= \${#typed}; j++ )); do
        [[ "\${typed[j]}" == "\${parts[j]}" ]] || ok=0
      done
      word="\${parts[\${#typed}+1]}"
      if (( ok )) && [[ " $next " != *" $word "* ]]; then next="$next $word"; fi
    fi
  done
  if [[ "$_${bin}_value_options" == *" $prev "* ]]; then
    candidates=""
    if [[ "$prev" == "--profile" ]]; then
      candidates="$(_${bin}_profiles)"
    else
      candidates="$(_${bin}_values_for "$matchcmd" "$prev")"
    fi
    compadd -- \${=candidates}
    return 0
  fi
  if [[ -n "$match" ]]; then
    candidates="$match"
    if [[ "$cur" != -* ]]; then
      values=""
      for line in "\${(@f)_${bin}_positionals}"; do
        [[ "$line" == "$matchcmd|$(( \${#typed} - matchlen ))|"* ]] && values="\${line##*|}"
      done
      if [[ -n "$values" ]]; then candidates="\${values//${PROFILES_WORD}/$(_${bin}_profiles)}"; fi
    fi
  elif (( \${#typed} == 0 )) && [[ "$cur" == -* ]]; then
    candidates="$_${bin}_root_options"
  else
    candidates="$next"
  fi
  compadd -- \${=candidates}
}

if [ "$funcstack[1]" = "_${bin}" ]; then
  _${bin} "$@"
else
  compdef _${bin} ${bin}
fi
`;
}

function fishScript(bin: string): string {
  return `# fish completion for ${bin}
set -g __${bin}_commands __TABLE__
set -g __${bin}_positionals __POSITIONALS__
set -g __${bin}_values __VALUES__
set -g __${bin}_value_options __VALUE_OPTIONS__
set -g __${bin}_root_options __ROOT_OPTIONS__

function __${bin}_profiles
    set -l dir "$XDG_CONFIG_HOME"
    if not string match -q '/*' -- "$dir"
        set dir "$HOME/.config"
    end
    set -l files $dir/${bin}/profiles/*.json 2>/dev/null
    for file in $files
        set -l name (string replace -r '.*/(.*)\\.json$' '$1' -- $file)
        string match -rq '^[A-Za-z0-9._-]+$' -- $name; or continue
        test "$name" = .; and continue
        test "$name" = ..; and continue
        echo $name
    end
end

function __${bin}_values_for --argument-names command option
    set -l found ""
    for line in $__${bin}_values
        set -l fields (string split '|' -- $line)
        if test "$fields[2]" = "$option"
            if test "$fields[1]" = "$command"
                echo $fields[3]
                return
            end
            if test "$fields[1]" = "*"
                set found $fields[3]
            end
        end
    end
    if test -n "$found"
        echo $found
    end
end

function __${bin}_complete
    set -l tokens (commandline -opc)
    set -e tokens[1]
    if contains -- "--" $tokens
        return
    end
    set -l current (commandline -ct)
    set -l words
    set -l skip 0
    for token in $tokens
        if test $skip -eq 1
            set skip 0
            continue
        end
        switch $token
            case '--*=*'
                continue
            case '-*'
                if contains -- $token $__${bin}_value_options
                    set skip 1
                end
            case '*'
                set words $words $token
        end
    end
    set -l count (count $words)
    set -l matchcmd ""
    for line in $__${bin}_commands
        set -l pair (string split -m1 '|' -- $line)
        set -l parts (string split ' ' -- $pair[1])
        if test $count -ge (count $parts)
            set -l ok 1
            for i in (seq (count $parts))
                if test "$words[$i]" != "$parts[$i]"
                    set ok 0
                end
            end
            if test $ok -eq 1
                set matchcmd $pair[1]
                break
            end
        end
    end
    if string match -qr -- '^--[a-z-]+=' $current
        set -l option (string replace -r '=.*' '' -- $current)
        if contains -- $option $__${bin}_value_options
            if test "$option" = "--profile"
                for name in (__${bin}_profiles)
                    echo "$option=$name"
                end
                return
            end
            set -l allowed (__${bin}_values_for "$matchcmd" "$option")
            if test -n "$allowed"
                for value in (string split ' ' -- $allowed)
                    echo "$option=$value"
                end
            end
            return
        end
    end
    set -l prev ""
    if test (count $tokens) -gt 0
        set prev $tokens[-1]
    end
    if contains -- $prev $__${bin}_value_options
        if test "$prev" = "--profile"
            __${bin}_profiles
            return
        end
        set -l allowed (__${bin}_values_for "$matchcmd" "$prev")
        if test -n "$allowed"
            string split ' ' -- $allowed
        end
        return
    end
    set -l candidates
    for line in $__${bin}_commands
        set -l pair (string split -m1 '|' -- $line)
        set -l parts (string split ' ' -- $pair[1])
        set -l ok 1
        if test $count -ge (count $parts)
            for i in (seq (count $parts))
                if test "$words[$i]" != "$parts[$i]"
                    set ok 0
                end
            end
            if test $ok -eq 1
                if not string match -q -- '-*' $current
                    set -l index (math $count - (count $parts))
                    for entry in $__${bin}_positionals
                        set -l fields (string split '|' -- $entry)
                        if test "$fields[1]" = "$pair[1]"; and test "$fields[2]" = "$index"
                            for value in (string split ' ' -- $fields[3])
                                if test "$value" = "${PROFILES_WORD}"
                                    __${bin}_profiles
                                else
                                    echo $value
                                end
                            end
                            return
                        end
                    end
                end
                string split ' ' -- $pair[2]
                return
            end
        else
            for i in (seq $count)
                if test "$words[$i]" != "$parts[$i]"
                    set ok 0
                end
            end
            if test $ok -eq 1
                set -a candidates $parts[(math $count + 1)]
            end
        end
    end
    if test $count -eq 0; and string match -q -- '-*' $current
        string split ' ' -- (string trim -- "$__${bin}_root_options")
        return
    end
    printf '%s\\n' $candidates | sort -u
end

complete -c ${bin} -f -a '(__${bin}_complete)'
`;
}
