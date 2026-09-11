# ============================================================
# 两面 · server 镜像
#
# 构建上下文 = ./apps/server（见 docker-compose.yml 的 build.context，勿改路径）
#
# 为什么不在镜像里 bun install：
#   @two-sides/contract 是 pnpm workspace 依赖（../../packages/contract），
#   而 compose 的 build context 只有 apps/server，镜像内拿不到契约包源码，
#   workspace 安装必然失败。因此与 web 侧做法一致 —— 产物在宿主机先构建：
#     pnpm -F @two-sides/server build    # 产出 apps/server/dist/index.js（自包含单文件）
#   这里只负责把产物装进 Bun 运行时。
#
# 运行时挂载（与 docker-compose.yml 严格对齐，改动需同步 compose）：
#   named volume server-data      -> /app/data
#                                  （ZHIDUAN_DB_PATH=/app/data/two-sides.db，见 compose）
#   ./config/providers.yaml (ro)  -> /app/config/providers.yaml
#                                  （PROVIDERS_CONFIG，见 compose；文件里只有 env 变量名，无密钥）
# ============================================================

FROM oven/bun:1

# 时区铁律：按日快照以东八区日期为主键（compose 也设了 TZ，这里是镜像级兜底）
ENV TZ=Asia/Shanghai \
    NODE_ENV=production

WORKDIR /app

# compose 的 healthcheck 用 curl 探活（/api/v1/health 的额度查询不消耗业务额度）；
# oven/bun:1 基于 debian slim，默认没有 curl，不装的话 healthcheck 永远失败。
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 只拷产物：镜像里没有源码、没有 node_modules、更没有任何密钥
# （若 dist/index.js 不存在，COPY 会直接失败 —— 先在宿主机跑 pnpm -F @two-sides/server build）
COPY dist/index.js ./index.js

EXPOSE 3000

CMD ["bun", "index.js"]
