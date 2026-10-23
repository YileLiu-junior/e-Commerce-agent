"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

type Message = { id: string; role: "user" | "assistant"; content: string };

const initialMessages: Message[] = [
  { id: "welcome-user-1", role: "user", content: "我买的沙发到哪了?" },
  { id: "welcome-ai-1", role: "assistant", content: "您的订单 86731 已到本地仓,预计明天送达~" },
  { id: "welcome-user-2", role: "user", content: "怎么退货?" },
  { id: "welcome-ai-2", role: "assistant", content: "支持 7 天无理由,我帮您发起~" }
];

const quickQuestions = ["查一下订单 86731 的物流", "零食怎么申请退货？", "食品拆封后还能退吗？"];
const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const flowDonePattern = /(已|已经|预计|支持|可以|帮您|为您|建议您|申请|发起|送达|退款|退货|换货|还有|如需|希望|祝您)/;
const shouldAskRatingSoon = (reply: string) => flowDonePattern.test(reply);

export default function DemoPage() {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const [lastRequestId, setLastRequestId] = useState<string>();
  const [ratingVisible, setRatingVisible] = useState(false);
  const [ratingDone, setRatingDone] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const ratingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, typing]);
  useEffect(() => () => { if (ratingTimerRef.current) clearTimeout(ratingTimerRef.current); }, []);

  function scheduleRating(reply: string) {
    if (ratingTimerRef.current) clearTimeout(ratingTimerRef.current);
    ratingTimerRef.current = setTimeout(() => setRatingVisible(true), shouldAskRatingSoon(reply) ? 1600 : 90000);
  }

  async function send(value = input) {
    const content = value.trim();
    if (!content || typing) return;
    if (ratingTimerRef.current) clearTimeout(ratingTimerRef.current);
    setMessages(current => [...current, { id: crypto.randomUUID(), role: "user", content }]);
    setInput(""); setTyping(true); setRatingDone(false); setRatingVisible(false);
    try {
      const [response] = await Promise.all([
        fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: content, sessionId }) }),
        wait(1000)
      ]);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Agent 暂时无法回复");
      setSessionId(data.sessionId);
      setLastRequestId(data.requestId);
      setMessages(current => [...current, { id: crypto.randomUUID(), role: "assistant", content: data.finalReply }]);
      scheduleRating(data.finalReply);
    } catch (error) {
      setMessages(current => [...current, { id: crypto.randomUUID(), role: "assistant", content: `抱歉，${error instanceof Error ? error.message : "服务暂时开了小差"}，请稍后再试。` }]);
    } finally { setTyping(false); }
  }

  function submit(event: FormEvent) { event.preventDefault(); void send(); }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
  }
  async function submitRating(score: number) {
    const qaPairs = messages.reduce<Array<{ question: string; answer: string }>>((pairs, message) => {
      if (message.role === "user") return [...pairs, { question: message.content, answer: "" }];
      const last = pairs.at(-1);
      if (last && !last.answer) last.answer = message.content;
      return pairs;
    }, []).filter(pair => pair.question && pair.answer);
    const response = await fetch("/api/ratings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ score, feedback: "", sessionId, requestId: lastRequestId, source: "demo", messages: messages.map(({ role, content }) => ({ role, content })), qaPairs }) });
    if (response.ok) { setRatingDone(true); setRatingVisible(false); }
  }

  return <main className="demo-shell">
    <section className="demo-chat" aria-label="零食小助手客服对话">
      <header className="demo-header">
        <div className="demo-title-mark">食</div>
        <div><h1>零食小助手</h1><p><i/>在线为您服务</p></div>
        <a href="/" className="demo-console-link">Agent 工作台</a>
      </header>

      <div className="demo-quick"><span>常见问题</span><div>{quickQuestions.map(question => <button key={question} disabled={typing} onClick={() => void send(question)}>{question}</button>)}</div></div>

      <div className="demo-messages" aria-live="polite">
        <div className="demo-time">今天 14:30</div>
        {messages.map(message => <div className={`demo-message ${message.role}`} key={message.id}>
          {message.role === "assistant" && <div className="demo-avatar">食</div>}
          <div><div className="demo-bubble">{message.content}</div>{message.role === "assistant" && <small>AI 客服 · 数据已核验</small>}</div>
        </div>)}
        {typing && <div className="demo-message assistant"><div className="demo-avatar">食</div><div className="demo-bubble demo-typing"><span/><span/><span/><em>正在输入…</em></div></div>}
        {ratingVisible && !ratingDone && <div className="demo-message assistant"><div className="demo-avatar">食</div><div><div className="demo-bubble demo-rating-card"><strong>这次服务帮到您了吗？</strong><div className="demo-stars">{[1, 2, 3, 4, 5].map(score => <button type="button" key={score} onClick={() => void submitRating(score)}>{score}</button>)}</div></div><small>评分会同步到运营中心</small></div></div>}
        {ratingDone && <div className="demo-message assistant"><div className="demo-avatar">食</div><div><div className="demo-bubble demo-rating-card done">感谢评分，祝您今天也有好胃口～</div></div></div>}
        <div ref={bottomRef}/>
      </div>

      <form className="demo-composer" onSubmit={submit}>
        <div className="demo-input-wrap"><textarea aria-label="输入消息" rows={1} placeholder="请输入您的问题…" value={input} onChange={event => setInput(event.target.value)} onKeyDown={onKeyDown}/><span>Enter 发送</span></div>
        <button className="demo-send" aria-label="发送" disabled={!input.trim() || typing} type="submit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 12 15-7-4.8 14-2.8-5.6L4 12Zm7.4 1.4L19 5"/></svg></button>
      </form>
      <footer className="demo-footer"><i/>{ratingDone ? "感谢评分，已同步运营中心" : "已连接 Planner、Tool 与风控 Agent"}</footer>
    </section>
  </main>;
}
