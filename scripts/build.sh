#!/bin/bash
# Build one or all Hugo blogs
# Usage: ./scripts/build.sh [blog_id]
# If no blog_id provided, builds all enabled blogs

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
HUGO="${HOME}/.local/bin/hugo"

build_blog() {
  local blog_id="$1"
  local site_dir="${PROJECT_ROOT}/sites/${blog_id}"
  local output_dir="${PROJECT_ROOT}/public/${blog_id}"

  if [ ! -d "$site_dir" ]; then
    echo "ERROR: Site directory not found: $site_dir"
    return 1
  fi

  echo "Building ${blog_id}..."
  $HUGO --source "$site_dir" \
        --themesDir "${PROJECT_ROOT}/themes" \
        --destination "$output_dir" \
        -F \
        --minify

  echo "Built ${blog_id} -> ${output_dir}"
}

if [ -n "$1" ]; then
  # Build specific blog
  build_blog "$1"
else
  # Build all enabled blogs from registry
  if command -v node &>/dev/null; then
    enabled_blogs=$(node -e "
      const r = require('${PROJECT_ROOT}/data/blog-registry.json');
      r.blogs.filter(b => b.enabled).forEach(b => console.log(b.id));
    ")
    for blog_id in $enabled_blogs; do
      build_blog "$blog_id"
    done
  else
    echo "Node.js required for registry parsing. Building tax-yearend only."
    build_blog "tax-yearend"
  fi
fi

echo "Build complete!"
