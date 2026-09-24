#!/bin/sh
set -eu

# Install the fork's integration line in a stable prefix and put a small
# launcher before the existing quota-axi executable in PREFIX/bin.
prefix=${1:-/opt/homebrew}
repo='https://github.com/jazz127/quota-axi.git'
install_dir="$prefix/opt/quota-axi-house"
source_dir="$install_dir/source"
bin_dir="$prefix/bin"
launcher="$bin_dir/quota-axi"
backup="$prefix/opt/quota-axi-house.released"

if [ -e "$install_dir" ] || [ -e "$backup" ]; then
  echo "Already installed (or incomplete install): $install_dir" >&2
  exit 1
fi
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  mkdir -p "$prefix/opt" "$bin_dir"
  mv "$launcher" "$backup"
else
  mkdir -p "$prefix/opt" "$bin_dir"
fi

restore_on_error() {
  rm -f "$launcher"
  if [ -e "$backup" ] || [ -L "$backup" ]; then
    mv "$backup" "$launcher"
  fi
  rm -rf "$install_dir"
}
trap restore_on_error EXIT HUP INT TERM

git clone --quiet --depth 1 --branch house "$repo" "$source_dir"
(cd "$source_dir" && corepack pnpm install --frozen-lockfile)
(cd "$source_dir" && corepack pnpm run build)
cat > "$launcher" <<EOF
#!/bin/sh
exec node "$source_dir/dist/bin/quota-axi.js" "\$@"
EOF
chmod +x "$launcher"
trap - EXIT HUP INT TERM
printf 'Installed fork house line. Put %s first on PATH.\n' "$bin_dir"
