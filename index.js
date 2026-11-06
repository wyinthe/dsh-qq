/**
 * dsh-qq —— 把 QQ（NapCat / OneBot11）接到 DeepSeek Harness。
 *
 * 进：QQ 私聊 → 投进 agent 会话（文字/图片/表情/语音转写）
 * 出：assistant 的回话 → NapCat send_private_msg（文字/图片/表情/语音条）
 *
 * 不引 @deepseek-ai/* 依赖，服务一律走 ctx.get("...") 并判空。
 * 配置项见 README。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const name = "dsh-qq";
export const inject = [];

const DEFAULTS = {
  // NapCat 的 OneBot11 WebSocket 服务端地址（NapCat 里开「WebSocket 服务器」）
  wsUrl: "ws://127.0.0.1:3001",
  // 和 NapCat 那边填的 token 一致；没设 token 就留空
  token: "",
  // 只接这些 QQ 号发来的私聊。必填，空数组 = 谁都不接（防止陌生人把你的 bot 当免费助手）
  owners: [],
  // 会话工作目录；留空用环境变量 DSH_WORKSPACE，再没有就用进程当前目录
  cwd: "",
  // 本地转写脚本（可选）。填了才处理语音；留空则收到语音只记一行占位
  // 约定：执行 `node <脚本> <wav路径>`，stdout 第一行是转写文本，可选的以 [语气] 开头的行是语气描述
  earScript: "",
  // 临时文件目录（收图/收语音都落这里）；默认系统临时目录下的 dsh-qq
  tmpDir: path.join(os.tmpdir(), "dsh-qq"),
  // 状态目录；留空用 <DSH_HOME>/qq
  stateDir: "",
  // 回一句话最多多少字（超了切段发）
  maxChars: 1800,
  // 会话用哪个模型。留空 = 跟 agent-default-model 走。
  // 注意：如果默认模型指向本地服务而那个服务没起，QQ 这边会回 503，建议显式填云端
  provider: "",
  model: "",
  // 把 QQ 接到指定的那间会话（填 sessionId 就一直用它，不新建）。
  // 留空 = 第一句话时自己新建一个会话
  sessionId: "",
  // 群消息：false = 只记日志不投递
  groupMessages: false,
};

function workdir(cfg) {
  return cfg.cwd || process.env.DSH_WORKSPACE || process.cwd();
}

function resolveStateDir(cfg) {
  if (cfg.stateDir) return cfg.stateDir;
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "qq");
}

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { sessionId: "", owner: 0 };
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

function textOf(event) {
  const blocks = event?.data?.message?.content ?? [];
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS, ...pickDefined(rawConfig) };
  const stateFile = path.join(resolveStateDir(cfg), "state.json");
  const state = loadState(stateFile);
  fs.mkdirSync(cfg.tmpDir, { recursive: true });

  if (!Array.isArray(cfg.owners) || cfg.owners.length === 0) {
    console.error("[dsh-qq] 没配 owners：所有私聊都会被忽略。把允许的 QQ 号填进配置里的 owners。");
  }

  let ws = null;
  let connected = false;
  let closed = false;
  let seq = 0;
  const pending = new Map();

  // ── OneBot 调用（带 echo 对应） ─────────────────────────────
  function call(action, params = {}, timeoutMs = 20000) {
    return new Promise((resolve) => {
      if (!connected || !ws) return resolve({ ok: false, reason: "未连接 NapCat" });
      const echo = String(++seq);
      pending.set(echo, resolve);
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        pending.delete(echo);
        return resolve({ ok: false, reason: String(err) });
      }
      setTimeout(() => {
        if (pending.has(echo)) {
          pending.delete(echo);
          resolve({ ok: false, reason: `${action} 超时` });
        }
      }, timeoutMs).unref?.();
    });
  }

  // ── 收语音：get_record → wav → 本地耳朵 ────────────────────
  function transcribeVoice(fileName) {
    const r = spawnSync(process.execPath, ["-e", `
      const ws = new WebSocket(${JSON.stringify(cfg.wsUrl)}, { headers: { Authorization: "Bearer ${cfg.token}" } });
      let done = false;
      ws.onopen = () => ws.send(JSON.stringify({ action: "get_record", params: { file: ${JSON.stringify(fileName)}, out_format: "wav" }, echo: "1" }));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.echo !== "1") return;
        done = true;
        if (m.data?.base64) process.stdout.write(m.data.base64);
        ws.close();
      };
      ws.onerror = () => { if (!done) { console.error("ws error"); process.exit(2); } };
      setTimeout(() => { if (!done) { console.error("timeout"); process.exit(3); } }, 15000);
    `], { encoding: "utf8", timeout: 30000 });
    if (r.status !== 0 || !r.stdout) return { ok: false, reason: r.stderr || "下载失败" };
    const wavPath = path.join(cfg.tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    try {
      fs.writeFileSync(wavPath, Buffer.from(r.stdout.trim(), "base64"));
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
    if (!cfg.earScript) {
      return { ok: false, reason: "没配 earScript（转写脚本），这条语音只留了占位" };
    }
    const ear = spawnSync(process.execPath, [cfg.earScript, wavPath], { encoding: "utf8", timeout: 180000 });
    const out = (ear.stdout || "").trim();
    if (!out) return { ok: false, reason: ear.stderr || "转写没有输出" };
    const lines = out.split(/\r?\n/).filter(Boolean);
    const words = lines.find((l) => !l.startsWith("[语气")) || "";
    const tone = lines.find((l) => l.startsWith("[语气]")) || "";
    return { ok: true, words, tone };
  }

  // ── 会话 ──────────────────────────────────────────────────
  async function ensureAgent() {
    const agents = ctx.get("agents");
    if (!agents) return undefined;
    // 配置里绑了 sessionId 就一直用那一间，
    // 不新建、不改写 state —— 这样 QQ 和面板里那间是同一段上下文。
    const bound = cfg.sessionId || "";
    const target = bound || state.sessionId;
    if (target) {
      const live = agents.get(target);
      if (live) return live;
      try {
        const handle = await agents.resume({ resumeSessionId: target, setup: agentSetup });
        return handle.agent;
      } catch (err) {
        console.error(`[dsh-qq] resume ${target} 失败: ${String(err)}\n${err?.stack ?? ""}`);
        if (bound) {
          // 绑定的那间 resume 不上就放弃，绝不偷偷新建——否则又是两个我
          console.error("[dsh-qq] 绑定的会话拿不到，这条消息丢弃（不会另开新会话）");
          return undefined;
        }
        state.sessionId = "";
        saveState(stateFile, state);
      }
    }
    try {
      const sessionId = `session-${crypto.randomUUID()}`;
      const rosterDefault = ctx.get("agentPresets")?.defaultId;
      const handle = await agents.create({
        sessionId,
        meta: { cwd: workdir(cfg), ...(rosterDefault ? { agentPreset: rosterDefault } : {}) },
        setup: agentSetup,
      });
      state.sessionId = sessionId;
      saveState(stateFile, state);
      if (handle?.agent?.id) state.sessionId = handle.agent.id, saveState(stateFile, state);
      await attachToWorkspace(state.sessionId);
      console.log(`[dsh-qq] 新建会话 ${state.sessionId}`);
      return handle.agent;
    } catch (err) {
      console.error(`[dsh-qq] 建会话失败: ${String(err)}\n${err?.stack ?? ""}`);
      return undefined;
    }
  }

  async function attachToWorkspace(sessionId) {
    const registry = ctx.get("workspaceRegistry");
    if (!registry || !sessionId) return;
    try {
      let workspace = await registry.resolveByPath(workdir(cfg));
      if (!workspace) workspace = await registry.create(workdir(cfg));
      await workspace.attachSession(sessionId);
    } catch (err) {
      console.error(`[dsh-qq] 会话挂工作区失败: ${String(err)}`);
    }
  }

  // 照 dsh-wechat 的写法来：setup 拿到的 agentCtx 是这次会话自己的作用域，
  // 所有服务都必须从 agentCtx 取（不能回落到插件自己的 ctx——插件一重载，
  // 那份 ctx 就是 inactive，mount 会报 cannot create effect on inactive context）。
  async function agentSetup(agentCtx, agent) {
    const live = agent ?? agentCtx?.agent;
    const presets = agentCtx?.get?.("agentPresets");
    if (presets) {
      try {
        await presets.mount(agentCtx, live?.session?.header?.agentPreset);
      } catch (err) {
        console.error(`[dsh-qq] preset mount 失败: ${String(err)}`);
      }
    }
    // 【模型变量】必须补上，否则第一轮直接报
    //   `prompt variable "{{model}}" has no value for this assembly`
    // 然后 turn 抛错、被引擎 kick() 的 catch 静默吃掉（症状：投递成功、没回复、没报错）。
    // 做法照 dsh-wechat 的 `dist/dsh/sessions.js` 的 legacy 分支：在
    // `system-prompt/assemble` 里补 provider/model，在 `agent/request` 里锁定同一次选择。
    installModelSelection(agentCtx, live);
    // ⚠ 必须返回 undefined（或带 .commit() 的作用域句柄）。
    // 引擎侧是 `(await setup(prepared.agent.ctx, prepared.agent))?.commit()`
    // —— 返回 agent 本身就会报 `commit is not a function`，整个建会话失败。
    return undefined;
  }

  function installModelSelection(agentCtx, live) {
    const defaultModel = agentCtx?.get?.("agentDefaultModel");
    const fixed = cfg.provider && cfg.model
      ? { provider: cfg.provider, model: cfg.model }
      : undefined;
    const currentSelection = () => {
      // 【顺序很重要】配置里写死的放最前。
      // 这个会话是按 agent-default-model 建出来的（11-04 起 = 本地 Qwen，
      // 127.0.0.1:9931），`requestHeader().config` 里记着的就是 local-qwen；
      // 它排前面的话，下面写死的 deepseek-account 永远用不上，照样 503。
      if (fixed) return fixed;
      const logged = live?.session?.requestHeader?.()?.config;
      if (logged?.provider && logged.model) {
        return {
          provider: logged.provider,
          model: logged.model,
          ...(logged.reasoningEffort ? { reasoningEffort: logged.reasoningEffort } : {}),
        };
      }
      return defaultModel?.currentSelection?.();
    };
    let assembledSelection;
    agentCtx.on?.("system-prompt/assemble", async (_assembly, _context, next) => {
      const selected = currentSelection();
      const assembled = await next();
      assembledSelection = selected;
      if (!selected?.provider || !selected.model) return assembled;
      return {
        ...assembled,
        variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
      };
    });
    agentCtx.on?.("agent/request", async (_payload, next) => {
      const resolved = await next();
      const selected = assembledSelection ?? currentSelection();
      if (!selected?.provider || !selected.model) return resolved;
      return {
        ...resolved,
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
      };
    });
  }

  // ── 收图：下载到本机（照 dsh-qq-onebot 的 downloadImage） ──────────
  const IMG_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp" };
  async function downloadImage(url) {
    try {
      fs.mkdirSync(cfg.tmpDir, { recursive: true });
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        console.error(`[dsh-qq] 图片下载失败: HTTP ${res.status}`);
        return "";
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 12 * 1024 * 1024) {
        console.error(`[dsh-qq] 图片大小不对: ${buf.length} B`);
        return "";
      }
      const ext = IMG_EXT[(res.headers.get("content-type") ?? "").split(";")[0].trim()] ?? ".jpg";
      const file = path.join(cfg.tmpDir, `qq-${Date.now()}-${crypto.randomBytes(2).toString("hex")}${ext}`);
      fs.writeFileSync(file, buf);
      return file;
    } catch (err) {
      console.error(`[dsh-qq] 图片下载出错: ${String(err)}`);
      return "";
    }
  }

  // ── 出：assistant → QQ ────────────────────────────────────
  // 支持三种出站标记（写在回复正文里，发出前会被剥掉）：
  //   [[img:绝对路径]]                  → 发一张本机图片
  //   [[face:编号]]                     → 发 QQ 内置表情，如 [[face:178]]
  //   [[mface:emoji_id/package_id/名字]] → 发商城表情包
  const outBuffer = new Map();

  // 【本机补丁 2026-11-06】出站要按来源分流（花猫：「我在桌面就在桌面回，我在手机就在手机回」）。
  //   以前每一轮只要结束就往 QQ 推一遍，桌面聊天也会被镜像到手机，很吵。
  //   做法：QQ 投递进来时开一个窗口，只有这轮窗口内的 assistant/message 才回推 QQ；
  //   回一次就把窗口关掉，桌面发起的轮次自然落不进来。
  //   30 分钟是「一轮最长能跑多久」，正常几秒就回来了；窗口过期不影响桌面。
  let qqTurnUntil = 0;
  const QQ_TURN_WINDOW_MS = 30 * 60 * 1000;

  function buildSegments(raw) {
    const segs = [];
    const re = /\[\[(img|face|mface):([^\]]+)\]\]/g;
    let last = 0;
    let m;
    const pushText = (t) => {
      if (!t) return;
      for (let i = 0; i < t.length; i += cfg.maxChars) {
        segs.push({ type: "text", data: { text: t.slice(i, i + cfg.maxChars) } });
      }
    };
    while ((m = re.exec(raw)) !== null) {
      pushText(raw.slice(last, m.index));
      const kind = m[1];
      const body = m[2].trim();
      if (kind === "img") {
        // ⚠ 实测：NapCat 若跑在 WSL 里，发 `file:///D:/...` 这类 Windows 路径会报
        //   `ENOENT`——它看不到 Windows 盘符，所以图片一律读成 base64 再发。
        //   `base64://` 能通（536 KB 的 png 一次 2 秒发出去），所以一律读成 base64 发。
        try {
          if (body && fs.existsSync(body)) {
            const b64 = fs.readFileSync(body).toString("base64");
            segs.push({ type: "image", data: { file: `base64://${b64}` } });
          } else {
            console.warn(`[dsh-qq] 图片不存在，跳过: ${body}`);
          }
        } catch (err) {
          console.error(`[dsh-qq] 读图片失败: ${String(err)}`);
        }
      } else if (kind === "face") {
        if (body) segs.push({ type: "face", data: { id: body } });
      } else if (kind === "mface") {
        const [emojiId = "", packageId = "", summary = ""] = body.split("/");
        if (emojiId) {
          segs.push({
            type: "mface",
            data: { emoji_id: emojiId, emoji_package_id: packageId || "1", summary: summary || "[表情]" },
          });
        }
      }
      last = m.index + m[0].length;
    }
    pushText(raw.slice(last));
    return segs;
  }

  function sendToQq(text) {
    const segs = buildSegments(text);
    if (!segs.length) return;
    void call("send_private_msg", {
      user_id: state.owner || cfg.owners[0],
      message: segs,
    }).then((r) => {
      if (r?.status !== "ok") console.warn(`[dsh-qq] 发送失败: ${JSON.stringify(r).slice(0, 200)}`);
    });
  }

  ctx.on("session/event", (session, event) => {
    const sid = sessionIdOf(session);
    // 绑了哪个会话就只回哪个会话
    const target = cfg.sessionId || state.sessionId;
    if (!sid || sid !== target) return;
    const type = event?.type;
    // 【诊断 2026-11-05】只打类型，不打内容：确认 assistant/message 到底有没有来。
    console.log(`[dsh-qq] 会话事件 ${type}`);
    if (type === "turn/start") {
      outBuffer.set(sid, []);
      return;
    }
    if (type === "assistant/message") {
      const t = textOf(event);
      if (t) {
        const buf = outBuffer.get(sid) ?? [];
        buf.push(t);
        outBuffer.set(sid, buf);
        // 只有「这轮是 QQ 发起的」才回推 QQ；桌面发起的轮次一个字都不发出去。
        if (!qqTurnUntil || Date.now() > qqTurnUntil) {
          console.log("[dsh-qq] 这轮不是 QQ 发起的，不回推");
          return;
        }
        qqTurnUntil = 0; // 一条消息回一次，回完就关窗，免得后面的续写又推一遍
        sendToQq(t);
      }
      return;
    }
  });

  // 【诊断】引擎的 kick() 会用 catch 静默吃掉 turn 抛的错，agent/error 是唯一出口。
  ctx.on("agent/error", (payload) => {
    console.error(`[dsh-qq] agent/error ${String(payload?.error ?? payload)}`);
  });

  // ── 进：QQ → agent ────────────────────────────────────────
  async function handleInbound(msg) {
    const from = Number(msg.user_id);
    if (!cfg.owners.includes(from)) {
      console.log(`[dsh-qq] 忽略非白名单私聊 ${from}`);
      return;
    }
    state.owner = from;
    saveState(stateFile, state);

    const blocks = [];
    for (const item of msg.message ?? []) {
      if (item.type === "text") {
        const t = item.data?.text;
        if (t) blocks.push({ type: "text", text: t });
      } else if (item.type === "record") {
        const fileName = item.data?.file;
        const r = fileName ? transcribeVoice(fileName) : { ok: false, reason: "没有 file 字段" };
        if (r.ok) {
          blocks.push({ type: "text", text: `[语音] ${r.words}` });
          if (r.tone) blocks.push({ type: "text", text: r.tone });
        } else {
          blocks.push({ type: "text", text: `[收到语音，转写失败：${r.reason}]` });
        }
      } else if (item.type === "image") {
        // 【2026-11-05】抄 dsh-qq-onebot：图片先下到本机，把路径当文字交给 agent，
        // agent 再用 read_image 打开——不占消息体积，也不依赖引擎支持图片块。
        const url = item.data?.url || item.data?.file || "";
        const file = url ? await downloadImage(url) : "";
        if (file) blocks.push({ type: "text", text: `[用户发了图片，已存到本机，可以直接用 read_image 打开：${file}]` });
        else blocks.push({ type: "text", text: "[收到图片，但没能下载下来]" });
      } else if (item.type === "face") {
        blocks.push({ type: "text", text: `[QQ表情 id=${item.data?.id ?? "?"}]` });
      } else if (item.type === "mface") {
        // 表情包：把「身份证」记下来，以后想发同一张就能发（出站用 [[mface:…]]）
        const d = item.data ?? {};
        blocks.push({
          type: "text",
          text: `[表情包 ${d.summary ? `「${d.summary}」` : ""}emoji_id=${d.emoji_id ?? "?"} package_id=${d.emoji_package_id ?? "?"}]`,
        });
      }
    }
    if (!blocks.length) blocks.push({ type: "text", text: "[空消息]" });

    const agent = await ensureAgent();
    if (!agent) {
      console.error("[dsh-qq] 投递失败: 没有可用的 agent（会话没建成）");
      return;
    }
    // 【投递】三步都试过，最后落在这条：
    //   ① `agent.followup(message)` 方法不存在（当时用可选链，异常被吞，静默不投）
    //   ② `agents.followup(agent, …)` 服务上没有这个方法 —— 那是我看错了，
    //      dsh-wechat 里的 `this.agents` 是它自己的 AgentStore 实例，
    //      AgentStore.followup 内部才去调 `agent.followup(message)`。
    //   ③ 于是回到 agent 自己的方法。引擎里真正的定义在
    //      `引擎\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js:806`
    //        followup(input) { this.send(input, "next-turn", true); }
    //        steer(input)    { this.send(input, "next-step", true); }
    //      ⇒ 传一个「用户消息」对象即可，不需要 id 回调。
    const userMsg = { id: crypto.randomUUID(), role: "user", content: blocks, source: { kind: "user" } };
    const mode = agent.status === "running" ? "steer" : "queue";
    try {
      if (typeof agent.followup !== "function") {
        console.error(
          `[dsh-qq] 投递失败: agent 上没有 followup。原型上的方法：` +
            `${Object.getOwnPropertyNames(Object.getPrototypeOf(agent) ?? {}).join(",")}`,
        );
        return;
      }
      if (mode === "steer" && typeof agent.steer === "function") agent.steer(userMsg);
      else agent.followup(userMsg);
      // 投进去了才算「这轮是 QQ 发起的」：从这一刻起窗口打开，这轮的回话会推回 QQ。
      qqTurnUntil = Date.now() + QQ_TURN_WINDOW_MS;
      // 【诊断】投进去之后立刻看状态：如果 status 还是 idle 且 inbox 空，
      // 说明消息被吞了（引擎 kick() 里的 catch 会静默吃掉 turn 抛的错）。
      console.log(
        `[dsh-qq] 已投递（${mode}）${userMsg.id} status=${agent.status} ` +
          `pending=${agent?.inbox?.hasPending} 阶段=${agent?.phase?.kind ?? "?"}`,
      );
    } catch (err) {
      console.error(`[dsh-qq] 投递失败: ${String(err)}\n${err?.stack ?? ""}`);
    }
  }

  // ── NapCat 连接 ───────────────────────────────────────────
  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(cfg.wsUrl, { headers: { Authorization: `Bearer ${cfg.token}` } });
    } catch (err) {
      console.error(`[dsh-qq] 建 WS 失败: ${String(err)}`);
      return void setTimeout(connect, 5000).unref?.();
    }
    ws.onopen = () => {
      connected = true;
      console.log(`[dsh-qq] 已连上 NapCat ${cfg.wsUrl}`);
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.echo && pending.has(String(m.echo))) {
        const resolve = pending.get(String(m.echo));
        pending.delete(String(m.echo));
        resolve(m);
        return;
      }
      // 诊断用：每条非回包事件打一行（2026-11-05 排查「消息到了 NapCat 但插件没动静」）
      // 2026-11-05 晚：群消息不再逐条打——群里一直在刷，日志涨得比对话快。只认私聊。
      if (m.post_type && m.post_type !== "meta_event" && m.message_type !== "group") {
        console.log(`[dsh-qq] 事件 ${m.post_type}/${m.message_type ?? "-"} from=${m.user_id ?? "-"} 段=${(m.message ?? []).map((s) => s.type).join(",")}`);
      }
      if (m.post_type === "message" && m.message_type === "private") {
        void handleInbound(m).catch((err) => console.error(`[dsh-qq] 处理私聊出错: ${String(err)}`));
      } else if (m.post_type === "message" && m.message_type === "group" && cfg.groupMessages) {
        void handleInbound(m).catch((err) => console.error(`[dsh-qq] 处理群消息出错: ${String(err)}`));
      }
    };
    ws.onclose = () => {
      connected = false;
      if (!closed) setTimeout(connect, 5000).unref?.();
    };
    ws.onerror = () => {
      // onclose 会跟着来
    };
  }

  connect();

  ctx.on("dispose", () => {
    closed = true;
    try {
      ws?.close();
    } catch {}
  });

  console.log(`[dsh-qq] 已加载：${cfg.wsUrl}，白名单 ${cfg.owners.join(",")}，会话 ${cfg.sessionId ? `${cfg.sessionId}（已绑定）` : state.sessionId || "（首次消息时新建）"}`);
}

function sessionIdOf(session) {
  if (!session || typeof session !== "object") return undefined;
  const s = session;
  for (const c of [s.id, s.header?.id, s.session?.header?.id, s.session?.id]) {
    if (typeof c === "string" && c) return c;
  }
  return undefined;
}

function pickDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
