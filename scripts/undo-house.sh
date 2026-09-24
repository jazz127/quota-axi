#!/bin/sh
set -eu

prefix=${1:-/opt/homebrew}
install_dir="$prefix/opt/quota-axi-house"
launcher="$prefix/bin/quota-axi"
backup="$prefix/opt/quota-axi-house.released"

if [ ! -d "$install_dir" ]; then
  echo "No quota-axi house installation found at $install_dir" >&2
  exit 1
fi
rm -f "$launcher"
if [ -e "$backup" ] || [ -L "$backup" ]; then
  mv "$backup" "$launcher"
fi
rm -rf "$install_dir"
printf 'Removed fork house line; released quota-axi is restored when one was present.\n'
