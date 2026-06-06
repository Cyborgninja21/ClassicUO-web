# Serving image for the ClassicUO-web WASM bundle.
#
# The bundle is built on the CI runner (the AOT build needs the frozen
# FNA-WASM-Build toolchain + statics — see .github/workflows/wasm-image.yml),
# then this image just packages the static output behind nginx. Build context
# is build-wasm/deploy/ with the published wwwroot copied in as ./wwwroot.
#
# NOTE: no UO art is baked in (EA-owned; player-supplied via the W5 OPFS picker).
# This serves the client app only.
FROM nginx:1.29-alpine

# Drop the stock site; install ours.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# The published WASM bundle (index.html + main.js + _framework/ + build-info.json).
COPY wwwroot/ /usr/share/nginx/html/

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=5s \
    CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1
