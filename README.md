# dsh-subagent-route-allowlist

在**每个会话开始时**自动构建「子 Agent 可选模型清单」，替代手写 `allowedModels`。

## 它解决什么问题

`@deepseek-ai/dsh-tool-subagent`（`modelSelection: true`）允许调用时指定
`provider` / `model` / `reasoning_effort`，但它只认**本会话**在
`subagent/model-selection-policy` 这个持久化投影事件里登记过的路线：

| 会话状态 | 显式指定子模型的规则 |
| --- | --- |
| 没有 policy 事件 | 只允许显式指定**父会话自己那条路线**（连只改 `reasoning_effort` 都会被拒） |
| 有 policy 事件 | **只有**清单里的 `(provider, model)` 允许；父会话自己的路线若不在清单里，也会被拒 |

投影的 `apply` 是「先写先赢」（`if (policy !== null) return policy`），所以这份清单
**只能在会话开始前/开始时**写一次，之后改配置对已存在的会话无效 —— 这就是
「改了 `cordis.patch.yml` 却没生效」的根因，必须开新会话。

官方插件 `@deepseek-ai/dsh-tool-subagent/model-selection-settings` 做的就是这件事，
但清单是静态配置。本插件把静态清单换成**算出来的清单**：

1. 本会话自己跑的路线（`includeSessionRoute`，避免"父路线被自己拒"的坑）；
2. `explicit` 里钉死的路线；
3. LLM 运行时为该 provider 广告出来的全部模型（`discovery`）；
4. 减去 `exclude`，截断到 `maxRoutes`。

> **清单里只有「路线」，没有「推理强度」。**
> `deepseek v4.1 max` = 路线 `easy-cliproxyapi/deepseek-v4.1-flash` + 调用时的
> `reasoning_effort: "max"`。`max` 由 LLM 运行时按模型自身广告的 effort 校验，
> 不在白名单里。想给所有子 Agent 一个默认强度，用 `tool-subagent` 自己的
> `agentOptions.reasoningEffort`。

## 安装（本地开发）

```powershell
# 1. 让 profile 的 node_modules 能解析到这个包（等价于 pnpm 的 link: 依赖）
cmd /c mklink /J "D:\dsh-home\profiles\desktop\node_modules\dsh-subagent-route-allowlist" "D:\projects\playground\dsh-subagent-route-allowlist"

# 2. 在 profile 的 cordis.patch.yml 里加一个顶层 entry（见下），然后重启 DSH
```

## 接线（`D:\dsh-home\profiles\desktop\cordis.patch.yml`）

```yaml
# 1) 让官方静态清单闭嘴（保持挂载：它还要负责子会话继承 + GUI 设置页）
- id: subagent-model-selection-settings
  name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings"
  config:
    enabled: false

# 2) 本插件接管
- id: subagent-route-allowlist
  name: dsh-subagent-route-allowlist
  config:
    enabled: true
    includeSessionRoute: true
    includeResumed: true
    inheritForSubagents: true
    maxRoutes: 40
    explicit: []
    exclude: []
    discovery:
      enabled: true
      providers: ["*"]        # 或 ["easy-cliproxyapi", "a6apo"]
      timeoutMs: 1500
      cacheTtlMs: 300000
```

**必须重启 DSH**（插件在 boot 时加载），并在**新会话**里验证：已存在的会话如果
已经有 policy 事件，改不了；没有 policy 的旧会话会在下次打开时补上
（`includeResumed: true`）。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后仍注册投影，但不写事件。 |
| `includeSessionRoute` | `true` | 把本会话自己跑的路线加进清单。强烈建议保持开启。 |
| `includeResumed` | `true` | 对已有历史的会话也补写清单（官方插件只写全新会话）。 |
| `inheritForSubagents` | `true` | 子会话继承父会话清单。官方插件也会做，二者幂等。 |
| `maxRoutes` | `40` | 清单上限。 |
| `explicit` | `[]` | 无论发现结果如何都写进去的路线，如 `{provider, model}`。 |
| `exclude` | `[]` | 永不写进去的路线。 |
| `discovery.enabled` | `true` | 是否向 LLM 运行时查询模型目录。 |
| `discovery.providers` | `["*"]` | provider id 列表，`"*"` = 所有已注册 provider。 |
| `discovery.timeoutMs` | `1500` | 单个 provider 目录查询预算，超时降级到缓存。 |
| `discovery.cacheTtlMs` | `300000` | 目录缓存时长（跨会话共享）。 |

## 验证

会话里让模型跑：

```text
list_subagent_models()                                  -> 允许的 provider
list_subagent_models(provider: "easy-cliproxyapi")      -> 允许的模型
list_subagent_models(provider: "easy-cliproxyapi", model: "deepseek-v4.1-flash")
                                                        -> 该模型的 reasoning efforts（应含 max）
```

然后：

```text
subagent(provider: "easy-cliproxyapi", model: "deepseek-v4.1-flash",
         reasoning_effort: "max", description: "...", prompt: "...")
```

## 已知边界

- 清单是**会话级且只写一次**：想让新规则生效，必须开新会话（或让旧会话在
  `includeResumed` 下首次打开时补写）。
- 发现结果依赖各 provider adapter 的 `listModels`；查询失败/超时会降级到缓存，
  完全失败时该 provider 贡献 0 条路线（不会让会话创建失败）。
- 本插件只写 `subagent/model-selection-policy`，不改 `tool-subagent` 的任何行为。
