import React from 'react';

export function renderInlineFormatting(text: string, isDark: boolean): React.ReactNode[] {
  // Split by inline code `...`, bold **...**, or [Source: ...] / [SOURCE ...] citations
  const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*|\[(?:Source|SOURCE)[^\]]+\])/g;
  const parts = text.split(tokenRegex);

  return parts.map((part, idx) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={idx}
          className={`px-1.5 py-0.5 rounded font-mono text-[11px] border ${
            isDark
              ? 'bg-[#0f131d] text-[#7da98f] border-[#263044]'
              : 'bg-slate-100 text-emerald-800 border-slate-300'
          }`}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong
          key={idx}
          className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
        >
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (/^\[(?:Source|SOURCE)[^\]]+\]$/.test(part)) {
      return (
        <span
          key={idx}
          className={`inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded text-[10px] font-mono font-semibold border ${
            isDark
              ? 'bg-violet-950/60 text-violet-300 border-violet-700/50'
              : 'bg-violet-50 text-violet-800 border-violet-200'
          }`}
        >
          {part}
        </span>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export function FormattedAIResponse({
  content,
  isDark
}: {
  content: string;
  isDark: boolean;
}) {
  if (!content) return null;

  // Handle fenced code blocks ```...```
  const segments = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-2.5 leading-relaxed">
      {segments.map((segment, segIdx) => {
        if (segment.startsWith('```') && segment.endsWith('```')) {
          const lines = segment.slice(3, -3).trim().split('\n');
          const firstLine = lines[0]?.trim() || '';
          const hasLang = /^[a-zA-Z0-9_-]+$/.test(firstLine);
          const codeBody = hasLang ? lines.slice(1).join('\n') : lines.join('\n');

          return (
            <div
              key={segIdx}
              className={`rounded-lg border overflow-hidden my-2 font-mono text-[11px] ${
                isDark
                  ? 'bg-[#0d1018] border-[#263042] text-slate-200'
                  : 'bg-slate-900 border-slate-800 text-slate-100'
              }`}
            >
              {hasLang && (
                <div className="px-3 py-1 text-[9px] uppercase tracking-wider font-bold border-b border-[#222b3b] bg-[#131824] text-[#7da98f]">
                  {firstLine}
                </div>
              )}
              <pre className="p-3 overflow-x-auto leading-normal">
                <code>{codeBody}</code>
              </pre>
            </div>
          );
        }

        const lines = segment.split('\n');
        return (
          <div key={segIdx} className="space-y-1.5">
            {lines.map((rawLine, lineIdx) => {
              const line = rawLine.trimEnd();
              if (!line.trim()) {
                return <div key={lineIdx} className="h-1" />;
              }

              // Headings
              if (line.startsWith('### ')) {
                return (
                  <h4
                    key={lineIdx}
                    className={`font-mono font-bold text-xs uppercase tracking-wider pt-1 ${
                      isDark ? 'text-[#7da98f]' : 'text-emerald-700'
                    }`}
                  >
                    {renderInlineFormatting(line.slice(4), isDark)}
                  </h4>
                );
              }
              if (line.startsWith('## ') || line.startsWith('# ')) {
                const headingText = line.replace(/^#+\s*/, '');
                return (
                  <h3
                    key={lineIdx}
                    className={`font-mono font-bold text-xs uppercase tracking-wider pt-1.5 pb-0.5 border-b ${
                      isDark
                        ? 'text-slate-100 border-[#263042]'
                        : 'text-slate-900 border-slate-200'
                    }`}
                  >
                    {renderInlineFormatting(headingText, isDark)}
                  </h3>
                );
              }

              // Bullet list item
              const bulletMatch = line.match(/^(\s*)[-*•]\s+(.*)$/);
              if (bulletMatch) {
                return (
                  <div key={lineIdx} className="flex items-start gap-2 pl-1">
                    <span className="text-[#7da98f] font-bold select-none mt-0.5">›</span>
                    <div className="flex-1 min-w-0">
                      {renderInlineFormatting(bulletMatch[2], isDark)}
                    </div>
                  </div>
                );
              }

              // Numbered list item
              const numMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
              if (numMatch) {
                return (
                  <div key={lineIdx} className="flex items-start gap-2 pl-1">
                    <span
                      className={`font-mono text-[10px] font-bold px-1.5 py-0.2 rounded shrink-0 mt-0.5 ${
                        isDark
                          ? 'bg-[#1c2436] text-[#7da98f] border border-[#2d3a54]'
                          : 'bg-slate-200 text-slate-800'
                      }`}
                    >
                      {numMatch[2]}
                    </span>
                    <div className="flex-1 min-w-0">
                      {renderInlineFormatting(numMatch[3], isDark)}
                    </div>
                  </div>
                );
              }

              return (
                <p key={lineIdx} className="leading-relaxed">
                  {renderInlineFormatting(line, isDark)}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
