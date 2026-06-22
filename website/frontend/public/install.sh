#!/usr/bin/env sh
set -eu

repo="${NSTACK_REPO:-https://git.nik.technology/angrymouse/nstack.git}"
ref="${NSTACK_REF:-main}"
home_dir="${NSTACK_HOME:-$HOME/.nstack}"
checkout="${home_dir}/cli"
bin_dir="${NSTACK_BIN_DIR:-$HOME/.local/bin}"
pnpm_version="${NSTACK_PNPM_VERSION:-10.18.3}"

say() {
  printf '%s\n' "$*"
}

fail() {
  say "nstack install: $*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required. Install it, then rerun this script."
}

node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0'
}

ensure_node() {
  need_command node
  major="$(node_major)"
  if [ "$major" -lt 22 ]; then
    fail "Node.js 22 or newer is required. Found Node $(node --version 2>/dev/null || printf unknown)."
  fi
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi
  need_command corepack
  say "pnpm is missing; enabling Corepack and activating pnpm@${pnpm_version}..."
  corepack enable
  corepack prepare "pnpm@${pnpm_version}" --activate
}

clone_or_update() {
  need_command git
  mkdir -p "$home_dir"
  if [ -d "$checkout/.git" ]; then
    say "Updating nstack checkout in ${checkout}..."
    git -C "$checkout" fetch origin "$ref" --depth 1 || git -C "$checkout" fetch origin "$ref"
    git -C "$checkout" checkout -B "$ref" FETCH_HEAD >/dev/null 2>&1 || git -C "$checkout" checkout "$ref"
    return
  fi
  if [ -e "$checkout" ]; then
    fail "${checkout} exists but is not a git checkout. Move it aside or set NSTACK_HOME."
  fi
  say "Cloning nstack from ${repo}..."
  if ! git clone --depth 1 --branch "$ref" "$repo" "$checkout"; then
    rm -rf "$checkout"
    git clone "$repo" "$checkout"
    git -C "$checkout" checkout "$ref" >/dev/null 2>&1 || true
  fi
}

install_cli() {
  say "Installing nstack dependencies..."
  (cd "$checkout" && CI=true pnpm install --no-frozen-lockfile)
  chmod +x "$checkout/bin/nstack.js"
  mkdir -p "$bin_dir"
  ln -sfn "$checkout/bin/nstack.js" "$bin_dir/nstack"
}

print_done() {
  version="$(node "$checkout/bin/nstack.js" --version 2>/dev/null || printf 'nstack')"
  say "Installed ${version} at ${bin_dir}/nstack"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) say "Add ${bin_dir} to PATH, for example: export PATH=\"${bin_dir}:\$PATH\"" ;;
  esac
  say "Next: nstack init my-app"
}

ensure_node
ensure_pnpm
clone_or_update
install_cli
print_done
