# Container image for the music re-mux Lambda (Phase 6, spec 10.1). AWS Node 20 base
# + a static ffmpeg. Build for linux/amd64 (Lambda's architecture) and push to ECR.
FROM public.ecr.aws/lambda/nodejs:20

# Static ffmpeg (johnvansickle amd64 build) → /usr/local/bin/ffmpeg. tar/xz come from
# the Amazon Linux package manager; the build is self-contained (no shared libs).
RUN dnf install -y tar xz && \
    curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o /tmp/ffmpeg.tar.xz && \
    mkdir -p /tmp/ffmpeg && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1 && \
    cp /tmp/ffmpeg/ffmpeg /usr/local/bin/ffmpeg && chmod +x /usr/local/bin/ffmpeg && \
    rm -rf /tmp/ffmpeg /tmp/ffmpeg.tar.xz && dnf clean all

# The handler. No npm deps (global fetch + node built-ins only).
COPY index.mjs ${LAMBDA_TASK_ROOT}/index.mjs
CMD [ "index.handler" ]
