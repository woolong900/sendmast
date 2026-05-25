# sendwalk MVP - 端到端冒烟测试 (Smoke Test)

目标：验证完整链路：注册 → 验域 → 导联系人 → 创活动 → 发送 → 收信 → 看到打开率。

## 前置条件

1. 已安装 Docker Desktop
2. 已 `cp .env.example .env`
3. 已 `pnpm install`
4. 已 `pnpm infra:up`（启动 postgres / redis / clickhouse / minio / mailhog）
5. 已 `pnpm db:migrate`（应用 PG schema）
6. 已 `pnpm db:seed`（写入 3 个系统模板）
7. 已 `pnpm ch:migrate`（应用 ClickHouse DDL）

## 启动所有服务

打开 5 个终端：

```bash
pnpm --filter @sendwalk/api dev          # API: http://localhost:4000
pnpm --filter @sendwalk/web dev          # Web: http://localhost:5173
pnpm --filter @sendwalk/worker-import dev
pnpm --filter @sendwalk/worker-sender dev
pnpm --filter @sendwalk/worker-events dev
```

或者一条命令并行起所有 dev：

```bash
pnpm dev
```

## 步骤

### 1. 注册并登录

- 访问 http://localhost:5173/signup
- 工作区名："冒烟工作区"，邮箱 `me@example.com`，密码 `Sendwalk123`
- 注册成功 → 自动登录 → 进入仪表盘
- ✅ 仪表盘显示 联系人 0 / 已订阅 0 / 进行中 0 / 已发送 0

### 2. 添加发件域名（DEV 模式跳过验证）

- 左侧导航 → 设置 → 发件域名 → 添加域名
- 输入 `example.com` → 生成 DNS 记录
- 点 "我已添加，开始检测"（DEV 环境 example.com 不会真验证通过；为了走通流程，可以手动在数据库里把 status 改成 `verified`）：

```bash
docker exec -it sendwalk-postgres psql -U sendwalk -d sendwalk \
  -c "UPDATE sender_domains SET status='verified', verified_at=NOW();"
```

- ✅ 列表显示 example.com 已验证

### 3. 创建联系人列表 + 导入 100 人

- 联系人 → 新建列表 "冒烟列表"
- 进入列表 → 导入 CSV，使用以下文件 `contacts100.csv`：

```bash
python3 - <<'PY' > /tmp/contacts100.csv
import csv, sys
w = csv.writer(sys.stdout)
w.writerow(["email","first_name","last_name"])
for i in range(1, 101):
    w.writerow([f"user{i:03d}@example.test", f"User", str(i)])
PY
mv /tmp/contacts100.csv ~/Desktop/contacts100.csv
```

- 在导入弹窗里选这个文件 → 开始导入
- ✅ 进度条 100% → 成功，列表数变成 100

### 4. 创建活动

- 营销活动 → 新建营销活动
  1. 基本信息：名称 "冒烟活动"，主题 "Hello {{first_name}}"，发件人显示名 "Smoke", 发件邮箱 `hello@example.com`
  2. 选择收件人：勾选 "冒烟列表"
  3. 选择模板：挑一个系统模板（Welcome）
  4. 预览 → 点 "创建草稿" → 点 "立即发送"

- ✅ 跳转到活动详情，状态变为 `sending`，再几秒后变为 `sent`

### 5. 在 Mailhog 看邮件

- 打开 http://localhost:8025
- ✅ 看到 100 封发往 `user001..100@example.test` 的邮件，主题为 "Hello {{first_name}}"

### 6. 手动触发"打开"

- 在 Mailhog 里随便点开一封邮件
- 切到 "Source" tab，找到 `<img src="http://localhost:4000/t/o/...gif" />`
- 复制这个 URL，在浏览器里打开它（或者直接 curl）：

```bash
curl -s "http://localhost:4000/t/o/<TOKEN>.gif" -o /dev/null
```

- ✅ 几秒后访问活动数据页 (`/campaigns/:id/analytics`)，"不重复打开率" > 0

### 7. 验证退订

- 在邮件源码里找到 `List-Unsubscribe: <http://localhost:4000/t/u/...>`
- 用浏览器打开这个链接
- ✅ 看到 "已退订成功" 页面
- ✅ 在联系人列表里搜索那个邮箱，状态变成 "已退订"

## 通过标准

| 检查项 | 期望 |
| ------ | ---- |
| 注册 / 登录 / me | ✅ |
| 域名 3 步骤 UI | ✅ |
| CSV 导入 100 行 | ✅ 100 inserted |
| 创建活动并发送 | ✅ status: sent |
| Mailhog 收到 100 封 | ✅ |
| 打开追踪 | ✅ unique_open >= 1 |
| 一键退订 | ✅ contact 状态变更 |
