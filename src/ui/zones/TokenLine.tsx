import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { StatusToken } from "../../runtime/types.js";
import { packTokens, TOKEN_SEPARATOR } from "../layout/status-tokens.js";
import { useTheme } from "../ui/hooks/use-theme.js";

export interface TokenLineProps {
  tokens: StatusToken[];
  width: number;
}

/** Renders a strip of status tokens packed to width, colors preserved. */
export function TokenLine({ tokens, width }: TokenLineProps): React.JSX.Element {
  const theme = useTheme();
  const packed = packTokens(tokens, width);
  return (
    <Box height={1} minHeight={1}>
      <Text>
        {packed.length > 0 ? (
          packed.map((token, i) => (
            <React.Fragment key={`${token.text}-${i}`}>
              {i > 0 && <Text color={theme.colors.mutedForeground}>{TOKEN_SEPARATOR}</Text>}
              <Text color={token.color}>{token.text}</Text>
            </React.Fragment>
          ))
        ) : (
          <Text> </Text>
        )}
      </Text>
    </Box>
  );
}
