import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { humanize, deepDive } from "@/lib/helion.functions";
import helionLogo from "@/assets/helion-logo.png";

export const Route = createFileRoute("/")({
  component: Helion,
});

/* ---------- DESIGN TOKENS — Obsidian Premium ---------- */
const C = {
  bg: "#050505",
  bgSoft: "#0A0A0B",
  surface: "rgba(255,255,255,0.03)",
  surfaceHi: "rgba(255,255,255,0.06)",
  border: "rgba(255,255,255,0.06)",
  borderAmber: "rgba(245,158,11,0.15)",
  borderAmberHi: "rgba(245,158,11,0.55)",
  text: "#F5F5F7",
  textMd: "#A1A1AA",
  textLt: "rgba(245,245,247,0.45)",
  textXLt: "rgba(245,245,247,0.4)",
  amber: "#F59E0B",
  amberHi: "#FBBF24",
  amberSoft: "rgba(245,158,11,0.08)",
  amberGlow: "0 0 24px rgba(245,158,11,0.35)",
  danger: "#EF4444",
};

const FONT_DISPLAY = `'Inter', system-ui, -apple-system, sans-serif`;
const FONT_BODY = `'Inter', system-ui, -apple-system, sans-serif`;
const FONT_MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, monospace`;

/* ---------- HELPFULNESS SCALE ---------- */
const SCALE: { value: number; phrase: string; icon: string }[] = [
  { value: 0, phrase: "Continuo no breu", icon: "🌑" },
  { value: 25, phrase: "Vejo uma pequena luz", icon: "🕯️" },
  { value: 50, phrase: "Um pé pra fora da caverna", icon: "🚪" },
  { value: 75, phrase: "Platão que se vire, eu tô indo embora dessa caverna", icon: "🏃" },
  { value: 100, phrase: "TO-TAL-MEN-TE ILUMINADO(A)", icon: "☀️" },
];

function Spinner() {
  return (
    <div style={{ position: "relative", width: 32, height: 32 }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          border: `2px solid ${C.border}`,
          borderTopColor: C.amber,
          animation: "spin 0.9s linear infinite",
        }}
      />
    </div>
  );
}

/* ---------- TYPES ---------- */
type Mode = "casual" | "tecnica";
type Length = "curta" | "longa";
type Analise = "padrao" | "codigo";

/* ---------- MAIN ---------- */
function Helion() {
  const [termo, setTermo] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  const [modo, setModo] = useState<Mode | null>("casual");
  const [tamanho, setTamanho] = useState<Length | null>("curta");
  const [analise, setAnalise] = useState<Analise | null>("padrao");
  const [loading, setLoading] = useState(false);
  const [resposta, setRespostaState] = useState<string | null>(null);
  const [foraEscopo, setForaEscopo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [score, setScore] = useState<number>(0);
  const [scoreTouched, setScoreTouched] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [deepOpen, setDeepOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [exitWarn, setExitWarn] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const callHumanize = useServerFn(humanize);

  const codeNeedsImage = analise === "codigo" && !imageDataUrl;
  const canSubmit =
    (termo.trim().length > 0 || imageDataUrl) &&
    modo &&
    tamanho &&
    analise &&
    !codeNeedsImage &&
    !loading;

  const handleFile = useCallback((file: File | null | undefined) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      setImageDataUrl(r.result as string);
      setImageName(file.name);
    };
    r.readAsDataURL(file);
  }, []);

  const reset = () => {
    setTermo("");
    setImageDataUrl(null);
    setImageName(null);
    setModo("casual");
    setTamanho("curta");
    setAnalise("padrao");
    setRespostaState(null);
    setForaEscopo(false);
    setErro(null);
    setScore(0);
    setScoreTouched(false);
    setDeepOpen(false);
  };

  // Guard: if user tries to leave with low score, warn.
  useEffect(() => {
    if (!resposta || !scoreTouched || score > 25) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [resposta, scoreTouched, score]);

  const attemptReset = () => {
    if (resposta && scoreTouched && score <= 25) {
      setExitWarn(true);
      return;
    }
    reset();
  };

  const submit = async () => {
    if (!canSubmit || !modo || !tamanho || !analise) return;
    setLoading(true);
    setRespostaState(null);
    setForaEscopo(false);
    setErro(null);
    setScore(0);
    setScoreTouched(false);
    try {
      const out = await callHumanize({ data: { termo, modo, tamanho, imageDataUrl, analise } });
      if (out.foraDeEscopo) setForaEscopo(true);
      else setRespostaState(out.texto);
    } catch (e: unknown) {
      setErro(e instanceof Error ? e.message : "Falha na requisição.");
    } finally {
      setLoading(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  /* ---- styles ---- */
  const pageBg: CSSProperties = {
    minHeight: "100vh",
    backgroundColor: C.bg,
    color: C.text,
    fontFamily: FONT_BODY,
    position: "relative",
    overflowX: "hidden",
    paddingBottom: 80,
  };

  const container: CSSProperties = {
    maxWidth: 720,
    margin: "0 auto",
    padding: "32px 24px 64px",
    position: "relative",
    zIndex: 1,
  };

  const glassCard: CSSProperties = {
    background: C.surface,
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
    borderRadius: 16,
    padding: 32,
    border: `1px solid ${C.border}`,
    animation: "fadeUp 0.45s ease both",
  };

  const labelStyle: CSSProperties = {
    fontFamily: FONT_MONO,
    fontSize: 10.5,
    letterSpacing: "0.16em",
    color: C.textLt,
    textTransform: "uppercase",
    marginBottom: 12,
    display: "block",
    fontWeight: 400,
  };

  const textareaStyle: CSSProperties = {
    width: "100%",
    minHeight: 72,
    background: "rgba(255,255,255,0.02)",
    border: `1px solid ${termo ? C.borderAmberHi : C.border}`,
    borderRadius: 12,
    padding: "14px 16px",
    fontFamily: FONT_BODY,
    fontSize: 15,
    lineHeight: 1.5,
    color: C.text,
    resize: "vertical",
    outline: "none",
    transition: "border-color 0.15s, box-shadow 0.15s",
    boxSizing: "border-box",
    boxShadow: termo ? `0 0 0 3px ${C.amberSoft}` : "none",
  };

  const currentScale = SCALE.find((s) => s.value === score) ?? SCALE[0];
  const recommendDeep = scoreTouched && (score === 50 || score === 75);
  const recommendAudit = scoreTouched && (score === 0 || score === 25);

  return (
    <div style={pageBg}>
      <style>{`
        @keyframes spin    { to { transform: rotate(360deg) } }
        @keyframes fadeUp  { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
        @keyframes slideIn { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }
        @keyframes overlayIn { from { opacity:0 } to { opacity:1 } }
        * { box-sizing: border-box; }
        html, body { background: ${C.bg}; }
        ::placeholder { color: ${C.textLt}; opacity: 0.8; }
        textarea:focus { border-color: ${C.borderAmberHi} !important; box-shadow: 0 0 0 3px ${C.amberSoft} !important; }
        a:hover { color: ${C.amberHi}; }
        .helion-primary:hover:not(:disabled) {
          box-shadow: ${C.amberGlow};
          border-color: ${C.amber};
        }
        .helion-ghost:hover { background: ${C.amberSoft}; border-color: ${C.amber}; color: ${C.amberHi}; }
        input[type=range].helion-slider {
          -webkit-appearance: none; appearance: none;
          width: 100%; height: 4px; background: ${C.border}; border-radius: 999px; outline: none;
        }
        input[type=range].helion-slider::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          width: 18px; height: 18px; border-radius: 50%;
          background: ${C.amber}; cursor: pointer;
          box-shadow: 0 0 0 4px rgba(245,158,11,0.15), 0 0 16px rgba(245,158,11,0.5);
          border: none;
        }
        input[type=range].helion-slider::-moz-range-thumb {
          width: 18px; height: 18px; border-radius: 50%;
          background: ${C.amber}; cursor: pointer; border: none;
          box-shadow: 0 0 0 4px rgba(245,158,11,0.15), 0 0 16px rgba(245,158,11,0.5);
        }
      `}</style>

      <div style={container}>
        {/* HEADER — uploaded logo */}
        <header style={{ textAlign: "center", marginBottom: 40 }}>
          <img
            src={helionLogo}
            alt="Helion — Traduzindo o técnico, iluminando o humano."
            style={{
              display: "block",
              width: "100%",
              maxWidth: 560,
              height: "auto",
              margin: "0 auto",
              userSelect: "none",
              pointerEvents: "none",
            }}
          />
        </header>

        {/* MAIN GLASS CARD */}
        <div style={glassCard}>
          {/* TEXTAREA */}
          <div>
            <span style={labelStyle}>Termo, sigla ou expressão</span>
            <textarea
              value={termo}
              onChange={(e) => setTermo(e.target.value)}
              onKeyDown={onKey}
              placeholder="API REST, machine learning, latência, Docker…"
              rows={2}
              style={textareaStyle}
            />
          </div>

          {/* UPLOAD ZONE */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFile(e.dataTransfer.files?.[0]);
            }}
            onClick={() => fileRef.current?.click()}
            style={{
              marginTop: 14,
              padding: imageDataUrl ? 10 : 14,
              border: `1px dashed ${imageDataUrl ? C.amber : dragOver ? C.amberHi : C.border}`,
              borderRadius: 12,
              background: imageDataUrl ? C.amberSoft : "rgba(255,255,255,0.02)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 12,
              justifyContent: imageDataUrl ? "flex-start" : "center",
              fontFamily: FONT_BODY,
              fontSize: 13,
              color: imageDataUrl ? C.amberHi : C.textLt,
              transition: "all 0.15s",
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            {imageDataUrl ? (
              <>
                <img
                  src={imageDataUrl}
                  alt={imageName ?? ""}
                  style={{
                    width: 40,
                    height: 40,
                    objectFit: "cover",
                    borderRadius: 6,
                    border: `1px solid ${C.amber}`,
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {imageName}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setImageDataUrl(null);
                    setImageName(null);
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: C.amber,
                    cursor: "pointer",
                    fontSize: 16,
                  }}
                  aria-label="remover imagem"
                >
                  ✕
                </button>
              </>
            ) : (
              <span>Anexar captura de tela (opcional)</span>
            )}
          </div>

          {/* MODE */}
          <div style={{ marginTop: 28 }}>
            <span style={labelStyle}>Modo de explicação</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <GlassOption
                active={modo === "casual"}
                onClick={() => setModo("casual")}
                label="Casual"
                desc="Linguagem sem formalidades, para qualquer pessoa"
              />
              <GlassOption
                active={modo === "tecnica"}
                onClick={() => setModo("tecnica")}
                label="Técnica"
                desc="Precisão cirúrgica, para quem é da área"
              />
            </div>
          </div>

          {/* LENGTH */}
          <div style={{ marginTop: 20 }}>
            <span style={labelStyle}>Tamanho da resposta</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <GlassOption
                active={tamanho === "curta"}
                onClick={() => setTamanho("curta")}
                label="Curta"
                desc="Definição direta e rápida"
              />
              <GlassOption
                active={tamanho === "longa"}
                onClick={() => setTamanho("longa")}
                label="Longa"
                desc="Aprofundada, com exemplos e contexto"
              />
            </div>
          </div>

          {/* ANÁLISE */}
          <div style={{ marginTop: 20 }}>
            <span style={labelStyle}>Tipo de análise</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <GlassOption
                active={analise === "padrao"}
                onClick={() => setAnalise("padrao")}
                label="Padrão"
                desc="Explica termos, siglas e expressões técnicas"
              />
              <GlassOption
                active={analise === "codigo"}
                onClick={() => setAnalise("codigo")}
                label="Código (imagem)"
                desc="Detecta a linguagem e explica o código linha a linha"
              />
            </div>
            {analise === "codigo" && !imageDataUrl && (
              <p
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: C.amber,
                  marginTop: 10,
                  letterSpacing: "0.04em",
                }}
              >
                Anexe uma captura de tela do código para ativar este modo.
              </p>
            )}
          </div>

          {/* SUBMIT */}
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="helion-primary"
            style={{
              marginTop: 28,
              width: "100%",
              padding: "15px 24px",
              borderRadius: 12,
              border: `1px solid ${canSubmit ? C.borderAmberHi : C.border}`,
              cursor: canSubmit ? "pointer" : "not-allowed",
              fontFamily: FONT_DISPLAY,
              fontWeight: 600,
              fontSize: 13,
              letterSpacing: "0.18em",
              color: canSubmit ? C.amber : C.textLt,
              background: "rgba(245,158,11,0.04)",
              transition: "all 0.2s ease",
              textTransform: "uppercase",
            }}
          >
            {loading ? "Processando…" : "Humanizar"}
          </button>
          {!canSubmit && (termo || imageDataUrl) && !loading && (
            <p
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: C.textLt,
                textAlign: "center",
                marginTop: 12,
              }}
            >
              Selecione modo e tamanho para ativar
            </p>
          )}
        </div>

        {/* LOADING */}
        {loading && (
          <div
            style={{
              ...glassCard,
              marginTop: 20,
              display: "flex",
              alignItems: "center",
              gap: 16,
              justifyContent: "center",
              padding: 28,
            }}
          >
            <Spinner />
            <span style={{ fontFamily: FONT_MONO, color: C.textMd, fontSize: 13 }}>
              Processando
            </span>
          </div>
        )}

        {/* FORA DE ESCOPO */}
        {foraEscopo && !loading && (
          <div style={{ ...glassCard, marginTop: 20, borderColor: C.borderAmberHi }}>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: C.amber,
                letterSpacing: "0.16em",
                marginBottom: 6,
              }}
            >
              FORA DE ESCOPO
            </div>
            <h3
              style={{
                fontFamily: FONT_DISPLAY,
                color: C.text,
                fontSize: 20,
                margin: "4px 0 12px",
                fontWeight: 600,
                letterSpacing: "-0.02em",
              }}
            >
              Termo fora do domínio técnico.
            </h3>
            <p style={{ fontFamily: FONT_BODY, color: C.textMd, fontSize: 14, lineHeight: 1.6 }}>
              Este sistema processa apenas tecnologia. Tente um termo, sigla ou expressão da área.
            </p>
            <button
              onClick={reset}
              style={{
                marginTop: 16,
                padding: "10px 16px",
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: "transparent",
                color: C.textMd,
                fontFamily: FONT_BODY,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Tentar novamente
            </button>
          </div>
        )}

        {/* ERROR */}
        {erro && !loading && (
          <div style={{ ...glassCard, marginTop: 20, borderColor: `${C.danger}55` }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.danger }}>
              Erro: {erro}
            </span>
          </div>
        )}

        {/* RESULTADO */}
        {resposta && !loading && (
          <div style={{ ...glassCard, marginTop: 20 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Badge label={modo === "casual" ? "Casual" : "Técnica"} />
              <Badge label={tamanho === "curta" ? "Curta" : "Longa"} />
            </div>
            <div style={{ height: 1, background: C.border, margin: "20px 0" }} />
            <RichText text={resposta} />

            {/* SCALE — Quanto nós te ajudamos? */}
            <HelpScale
              score={score}
              onChange={(v) => {
                setScore(v);
                setScoreTouched(true);
              }}
              current={currentScale}
            />

            {/* Recommended action prompt */}
            {scoreTouched && (recommendDeep || recommendAudit) && (
              <div
                style={{
                  marginTop: 16,
                  padding: "12px 14px",
                  borderRadius: 10,
                  background: C.amberSoft,
                  border: `1px solid ${C.borderAmber}`,
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  color: C.amberHi,
                  letterSpacing: "0.02em",
                }}
              >
                {recommendDeep
                  ? "↓ Sugestão: abra o Compêndio Avançado para aprofundar."
                  : "↓ Sugestão: nos ajude a calibrar — aponte o que erramos."}
              </div>
            )}

            {/* COMPÊNDIO */}
            <button
              onClick={() => setDeepOpen(true)}
              className="helion-ghost"
              style={{
                marginTop: 20,
                width: "100%",
                padding: "13px 18px",
                borderRadius: 12,
                border: `1px solid ${recommendDeep ? C.borderAmberHi : C.borderAmber}`,
                background: recommendDeep ? C.amberSoft : "transparent",
                color: C.amber,
                fontFamily: FONT_DISPLAY,
                fontWeight: 500,
                fontSize: 14,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              Abrir Compêndio Avançado
            </button>

            {/* AUDIT BUTTON — bottom centered */}
            <div style={{ marginTop: 24, display: "flex", justifyContent: "center" }}>
              <AuditButton onClick={() => setAuditOpen(true)} emphasized={recommendAudit} />
            </div>

            {/* Nova consulta */}
            <div style={{ marginTop: 18, textAlign: "center" }}>
              <button
                onClick={attemptReset}
                style={{
                  background: "transparent",
                  border: "none",
                  fontFamily: FONT_MONO,
                  color: C.textLt,
                  cursor: "pointer",
                  fontSize: 11,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                }}
              >
                Nova consulta →
              </button>
            </div>
          </div>
        )}
      </div>

      {deepOpen &&
        resposta &&
        (() => {
          const langMatch =
            analise === "codigo" ? resposta.match(/Linguagem detectada:\*\*\s*([^\n*]+)/i) : null;
          const deepTermo = langMatch?.[1]?.trim() || termo || "imagem enviada";
          return (
            <DeepDiveView
              termo={deepTermo}
              analise={analise ?? "padrao"}
              contextoCodigo={analise === "codigo" ? resposta.slice(0, 1200) : null}
              onClose={() => setDeepOpen(false)}
              onAudit={() => setAuditOpen(true)}
            />
          );
        })()}

      {auditOpen && (
        <AuditModal
          termo={termo || "imagem enviada"}
          resposta={resposta ?? ""}
          onClose={() => setAuditOpen(false)}
        />
      )}

      {exitWarn && (
        <ExitWarnModal
          onStay={() => {
            setExitWarn(false);
            setAuditOpen(true);
          }}
          onLeave={() => {
            setExitWarn(false);
            reset();
          }}
        />
      )}

      {/* INSTITUTIONAL FOOTER */}
      <InstitutionalFooter />
    </div>
  );
}

/* ---------- SUB-COMPONENTS ---------- */
function GlassOption({
  active,
  onClick,
  label,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  desc: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: "14px 16px",
        borderRadius: 12,
        border: `1px solid ${active ? C.borderAmberHi : C.borderAmber}`,
        background: active ? C.amberSoft : C.surface,
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        cursor: "pointer",
        fontFamily: FONT_BODY,
        transition: "all 0.2s ease",
        boxShadow: active ? `0 0 0 3px ${C.amberSoft}` : "none",
      }}
    >
      <div
        style={{
          fontFamily: FONT_DISPLAY,
          fontWeight: 600,
          fontSize: 14,
          color: active ? C.amberHi : C.text,
          letterSpacing: "-0.01em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          fontWeight: 300,
          color: C.textXLt,
          marginTop: 4,
          lineHeight: 1.5,
        }}
      >
        {desc}
      </div>
    </button>
  );
}

function Badge({ label }: { label: string }) {
  return (
    <span
      style={{
        fontFamily: FONT_MONO,
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        padding: "4px 9px",
        borderRadius: 4,
        color: C.textMd,
        border: `1px solid ${C.border}`,
        background: "rgba(255,255,255,0.02)",
      }}
    >
      {label}
    </span>
  );
}

function RichText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const paragraphs = text.split(/\n{2,}/);
    return paragraphs.map((p) => p.split(/(\*\*[^*]+\*\*)/g));
  }, [text]);
  return (
    <div style={{ fontFamily: FONT_BODY, color: C.textMd, fontSize: 15, lineHeight: 1.7 }}>
      {parts.map((para, i) => (
        <p key={i} style={{ margin: "0 0 14px" }}>
          {para.map((seg, j) =>
            seg.startsWith("**") && seg.endsWith("**") ? (
              <strong key={j} style={{ color: C.text, fontWeight: 600 }}>
                {seg.slice(2, -2)}
              </strong>
            ) : (
              <span key={j}>{seg}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function HelpScale({
  score,
  onChange,
  current,
}: {
  score: number;
  onChange: (v: number) => void;
  current: { phrase: string; icon: string; value: number };
}) {
  return (
    <div
      style={{
        marginTop: 28,
        paddingTop: 22,
        borderTop: `1px solid ${C.border}`,
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          letterSpacing: "0.16em",
          color: C.textLt,
          textTransform: "uppercase",
          marginBottom: 16,
          textAlign: "center",
        }}
      >
        Quanto nós te ajudamos?
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
          minHeight: 56,
        }}
      >
        <span
          style={{ fontSize: 28, filter: "drop-shadow(0 0 8px rgba(245,158,11,0.4))" }}
          aria-hidden
        >
          {current.icon}
        </span>
        <span
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 15,
            color: C.text,
            fontStyle: "italic",
            textAlign: "center",
            maxWidth: 380,
          }}
        >
          “{current.phrase}”
        </span>
      </div>

      <input
        type="range"
        min={0}
        max={100}
        step={25}
        value={score}
        onChange={(e) => onChange(Number(e.target.value))}
        className="helion-slider"
        aria-label="Quanto nós te ajudamos"
      />

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 10,
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: C.textLt,
          letterSpacing: "0.08em",
        }}
      >
        {SCALE.map((s) => (
          <span
            key={s.value}
            style={{ color: score === s.value ? C.amber : C.textLt, transition: "color 0.2s" }}
          >
            {s.value}%
          </span>
        ))}
      </div>
    </div>
  );
}

function AuditButton({ onClick, emphasized }: { onClick: () => void; emphasized?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="helion-ghost"
      style={{
        padding: "12px 28px",
        borderRadius: 999,
        border: `1px solid ${emphasized ? C.borderAmberHi : C.borderAmber}`,
        background: emphasized ? C.amberSoft : "transparent",
        color: C.amber,
        fontFamily: FONT_MONO,
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: "0.22em",
        cursor: "pointer",
        textTransform: "uppercase",
        transition: "all 0.2s ease",
        boxShadow: emphasized ? "0 0 24px rgba(245,158,11,0.18)" : "none",
      }}
    >
      Erramos em algo?
    </button>
  );
}

/* ---------- AUDIT MODAL ---------- */
function AuditModal({
  termo,
  resposta,
  onClose,
}: {
  termo: string;
  resposta: string;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    if (!text.trim()) return;
    setSending(true);
    // Simulação: log estruturado para backlog + alerta de e-mail.
    const payload = {
      to: "casthiel.augusto@gmail.com",
      subject: `[HELION · Auditoria] Contestação em "${termo}"`,
      termo,
      respostaOriginal: resposta,
      contestacao: text,
      timestamp: new Date().toISOString(),
      priority: "high",
    };
    console.info("[HELION · AUDIT BACKLOG]", payload);
    await new Promise((r) => setTimeout(r, 600));
    setSending(false);
    setSent(true);
    setTimeout(onClose, 1600);
  };

  return (
    <Overlay onClose={onClose}>
      <div
        style={{
          width: "100%",
          maxWidth: 560,
          background: C.bgSoft,
          border: `1px solid ${C.borderAmber}`,
          borderRadius: 18,
          padding: 28,
          boxShadow: "0 30px 80px rgba(0,0,0,0.7), 0 0 60px rgba(245,158,11,0.08)",
          animation: "slideIn 0.25s ease both",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10.5,
            letterSpacing: "0.22em",
            color: C.amber,
            textTransform: "uppercase",
            marginBottom: 14,
          }}
        >
          Auditoria de precisão
        </div>
        <p
          style={{ fontFamily: FONT_BODY, color: C.text, fontSize: 15, lineHeight: 1.6, margin: 0 }}
        >
          Para nos ajudar a calibrar a precisão do Helion, aponte o erro encontrado.
        </p>
        <p
          style={{
            fontFamily: FONT_MONO,
            color: C.textLt,
            fontSize: 12,
            lineHeight: 1.6,
            marginTop: 8,
            fontWeight: 300,
          }}
        >
          Se possível, inclua links de documentações oficiais, referências ou URLs de capturas de
          tela.
        </p>

        {!sent ? (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder="Descreva o que erramos…"
              style={{
                marginTop: 18,
                width: "100%",
                background: "rgba(255,255,255,0.02)",
                border: `1px solid ${C.border}`,
                borderRadius: 12,
                padding: "14px 16px",
                fontFamily: FONT_BODY,
                fontSize: 14,
                color: C.text,
                outline: "none",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
              <button
                onClick={onClose}
                style={{
                  padding: "10px 18px",
                  borderRadius: 10,
                  border: `1px solid ${C.border}`,
                  background: "transparent",
                  color: C.textMd,
                  fontFamily: FONT_BODY,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Cancelar
              </button>
              <button
                onClick={submit}
                disabled={!text.trim() || sending}
                className="helion-primary"
                style={{
                  padding: "10px 22px",
                  borderRadius: 10,
                  border: `1px solid ${C.borderAmberHi}`,
                  background: C.amberSoft,
                  color: C.amber,
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  fontWeight: 500,
                  letterSpacing: "0.18em",
                  cursor: text.trim() && !sending ? "pointer" : "not-allowed",
                  textTransform: "uppercase",
                  opacity: text.trim() && !sending ? 1 : 0.5,
                }}
              >
                {sending ? "Enviando…" : "Enviar"}
              </button>
            </div>
          </>
        ) : (
          <div
            style={{
              marginTop: 22,
              padding: 18,
              borderRadius: 12,
              background: C.amberSoft,
              border: `1px solid ${C.borderAmber}`,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 28, marginBottom: 6 }}>✨</div>
            <div
              style={{ fontFamily: FONT_DISPLAY, color: C.amberHi, fontSize: 15, fontWeight: 600 }}
            >
              Contestação registrada.
            </div>
            <div
              style={{
                fontFamily: FONT_MONO,
                color: C.textLt,
                fontSize: 11,
                marginTop: 6,
                letterSpacing: "0.04em",
              }}
            >
              Alerta de alta prioridade despachado.
            </div>
          </div>
        )}
      </div>
    </Overlay>
  );
}

/* ---------- EXIT WARNING ---------- */
function ExitWarnModal({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  return (
    <Overlay onClose={onStay}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 460,
          background: C.bgSoft,
          border: `1px solid ${C.borderAmber}`,
          borderRadius: 18,
          padding: 28,
          textAlign: "center",
          boxShadow: "0 30px 80px rgba(0,0,0,0.7)",
          animation: "slideIn 0.25s ease both",
        }}
      >
        <div style={{ fontSize: 32, marginBottom: 8 }}>🦁</div>
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 18,
            color: C.text,
            fontWeight: 600,
            lineHeight: 1.4,
          }}
        >
          Hey, ajuda a gente a ajudar todo mundo antes de sair…
        </div>
        <p
          style={{
            fontFamily: FONT_MONO,
            fontSize: 12,
            color: C.textLt,
            marginTop: 10,
            lineHeight: 1.6,
          }}
        >
          Sua contestação calibra a precisão do Helion para os próximos.
        </p>
        <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={onStay}
            className="helion-ghost"
            style={{
              padding: "12px 24px",
              borderRadius: 999,
              border: `1px solid ${C.borderAmberHi}`,
              background: C.amberSoft,
              color: C.amber,
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.22em",
              cursor: "pointer",
              textTransform: "uppercase",
            }}
          >
            Erramos em algo?
          </button>
          <button
            onClick={onLeave}
            style={{
              padding: "8px 12px",
              border: "none",
              background: "transparent",
              color: C.textLt,
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.14em",
              cursor: "pointer",
              textTransform: "uppercase",
            }}
          >
            Sair mesmo assim
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- OVERLAY ---------- */
function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.78)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        animation: "overlayIn 0.2s ease both",
      }}
    >
      {children}
    </div>
  );
}

/* ---------- INSTITUTIONAL FOOTER ---------- */
function InstitutionalFooter() {
  return (
    <footer
      style={{
        position: "relative",
        marginTop: 64,
        borderTop: "1px solid rgba(255,255,255,0.05)",
        padding: "16px 24px",
        maxWidth: 1200,
        marginInline: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: FONT_MONO,
          fontSize: 10.5,
          color: "rgba(245,245,247,0.4)",
          letterSpacing: "0.06em",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span>HELION © 2026 · ENGINE DE INTELIGÊNCIA FACTUAL</span>
        <span style={{ fontStyle: "italic", letterSpacing: "0.02em" }}>
          Inspirado por Helena Laura de Farias, a leoa que iluminou todo o caminho.
        </span>
      </div>
    </footer>
  );
}

/* ---------- DEEP DIVE ---------- */
function DeepDiveView({
  termo,
  analise,
  contextoCodigo,
  onClose,
  onAudit,
}: {
  termo: string;
  analise: Analise;
  contextoCodigo: string | null;
  onClose: () => void;
  onAudit: () => void;
}) {
  const callDeep = useServerFn(deepDive);
  const [data, setData] = useState<null | Awaited<ReturnType<typeof callDeep>>>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useMemo(() => {
    setLoading(true);
    callDeep({ data: { termo, analise, contextoCodigo } })
      .then((d) => setData(d))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Falha ao carregar compêndio"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termo, analise]);

  const q = encodeURIComponent(termo);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: C.bg,
        overflowY: "auto",
        animation: "slideIn 0.3s ease both",
      }}
    >
      <div
        style={{
          maxWidth: 760,
          margin: "0 auto",
          padding: "40px 24px 96px",
          position: "relative",
          zIndex: 1,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: "0.16em",
                color: C.amber,
                textTransform: "uppercase",
                fontWeight: 500,
              }}
            >
              Compêndio Avançado
            </div>
            <div
              style={{
                fontFamily: FONT_DISPLAY,
                fontSize: 28,
                fontWeight: 600,
                color: C.text,
                letterSpacing: "-0.025em",
                marginTop: 4,
              }}
            >
              {termo}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: `1px solid ${C.border}`,
              padding: "10px 16px",
              borderRadius: 10,
              cursor: "pointer",
              fontFamily: FONT_BODY,
              fontSize: 13,
              color: C.textMd,
            }}
          >
            Voltar
          </button>
        </div>
        <div style={{ height: 1, background: C.border, margin: "28px 0" }} />

        {loading && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 14,
              padding: "60px 0",
            }}
          >
            <Spinner />
            <span style={{ fontFamily: FONT_MONO, color: C.textMd, fontSize: 12 }}>
              Processando
            </span>
          </div>
        )}

        {err && (
          <div
            style={{
              background: C.surface,
              border: `1px solid ${C.danger}55`,
              padding: 16,
              borderRadius: 10,
              fontFamily: FONT_MONO,
              color: C.danger,
            }}
          >
            Erro: {err}
          </div>
        )}

        {data && (
          <>
            <DeepSection label="Exploração completa">
              <RichText text={data.profundidade} />
            </DeepSection>
            {data.exemplo && (
              <DeepSection label="Exemplo real">
                <RichText text={data.exemplo} />
              </DeepSection>
            )}
            {data.analogia && (
              <DeepSection label="Analogia">
                <p
                  style={{
                    fontFamily: FONT_BODY,
                    fontStyle: "italic",
                    color: C.textMd,
                    fontSize: 16,
                    lineHeight: 1.65,
                    margin: 0,
                  }}
                >
                  {data.analogia}
                </p>
              </DeepSection>
            )}
            {data.relacionados.length > 0 && (
              <DeepSection label="Conceitos relacionados">
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {data.relacionados.map((r: string) => (
                    <a
                      key={r}
                      href={`https://www.google.com/search?q=${encodeURIComponent(r)}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        padding: "6px 12px",
                        borderRadius: 6,
                        background: "rgba(255,255,255,0.02)",
                        border: `1px solid ${C.border}`,
                        color: C.amber,
                        fontFamily: FONT_BODY,
                        fontSize: 13,
                        textDecoration: "none",
                      }}
                    >
                      {r}
                    </a>
                  ))}
                </div>
              </DeepSection>
            )}
            <DeepSection label="Para aprender mais">
              <div style={{ display: "grid", gap: 10 }}>
                <LinkCard
                  title="YouTube"
                  subtitle={`Vídeos sobre "${termo}"`}
                  href={`https://www.youtube.com/results?search_query=${q}`}
                />
                <LinkCard
                  title="Wikipédia"
                  subtitle="Artigo enciclopédico"
                  href={`https://pt.wikipedia.org/wiki/Special:Search?search=${q}`}
                />
                <LinkCard
                  title="Busca avançada"
                  subtitle="Google + tutorial"
                  href={`https://www.google.com/search?q=${q}+tutorial`}
                />
                {data.docLink && (
                  <LinkCard
                    title="Documentação oficial"
                    subtitle="Fonte primária"
                    href={data.docLink}
                  />
                )}
              </div>
            </DeepSection>

            {analise === "codigo" && data.videos.length > 0 && (
              <DeepSection label="Vídeos recomendados">
                <div style={{ display: "grid", gap: 10 }}>
                  {data.videos.map((v) => (
                    <LinkCard
                      key={v.url}
                      title={v.titulo}
                      subtitle="YouTube · vídeo"
                      href={v.url}
                    />
                  ))}
                </div>
              </DeepSection>
            )}
            {analise === "codigo" && data.artigos.length > 0 && (
              <DeepSection label="Artigos e textos">
                <div style={{ display: "grid", gap: 10 }}>
                  {data.artigos.map((v) => (
                    <LinkCard key={v.url} title={v.titulo} subtitle="Artigo / texto" href={v.url} />
                  ))}
                </div>
              </DeepSection>
            )}
            {analise === "codigo" && data.exemplosLinks.length > 0 && (
              <DeepSection label="Exemplos práticos">
                <div style={{ display: "grid", gap: 10 }}>
                  {data.exemplosLinks.map((v) => (
                    <LinkCard
                      key={v.url}
                      title={v.titulo}
                      subtitle="Exemplo / repositório"
                      href={v.url}
                    />
                  ))}
                </div>
              </DeepSection>
            )}

            {/* AUDIT BUTTON inside deep dive */}
            <div style={{ marginTop: 36, display: "flex", justifyContent: "center" }}>
              <AuditButton onClick={onAudit} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DeepSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 28 }}>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          letterSpacing: "0.16em",
          color: C.textLt,
          textTransform: "uppercase",
          marginBottom: 12,
          fontWeight: 400,
        }}
      >
        {label}
      </div>
      <div
        style={{
          background: C.surface,
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          padding: 22,
        }}
      >
        {children}
      </div>
    </section>
  );
}

function LinkCard({ title, subtitle, href }: { title: string; subtitle: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 16px",
        borderRadius: 10,
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${C.border}`,
        textDecoration: "none",
        color: C.text,
        transition: "all 0.15s",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 14, color: C.text }}>
          {title}
        </div>
        <div style={{ fontFamily: FONT_BODY, color: C.textLt, fontSize: 12, marginTop: 2 }}>
          {subtitle}
        </div>
      </div>
      <span style={{ fontFamily: FONT_MONO, color: C.amber }}>→</span>
    </a>
  );
}
