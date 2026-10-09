import React from "react";
import { Text } from "ink";
import { Span } from "../markdown.js";
import { themeColors } from "../layout/theme-map.js";

/** Renders one markdown-parsed line's spans (see markdown.ts). */
export function SpanText({
  spans,
  color,
  dimColor,
}: {
  spans: Span[];
  color?: string;
  dimColor?: boolean;
}): React.JSX.Element {
  return (
    <Text wrap="truncate" color={color} dimColor={dimColor}>
      {spans.map((s, j) => {
        if (s.ansi) return <Text key={j}>{s.text}</Text>;
        if (s.code) return <Text key={j} color={color ?? themeColors().warning}>{` ${s.text} `}</Text>;
        return (
          <Text
            key={j}
            bold={s.bold}
            italic={s.italic}
            strikethrough={s.strikethrough}
            color={color ?? s.color}
            dimColor={dimColor ?? s.dimColor}
          >
            {s.text}
          </Text>
        );
      })}
    </Text>
  );
}
