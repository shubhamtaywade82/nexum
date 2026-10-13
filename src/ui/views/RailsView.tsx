import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { ViewProps } from "./ConversationView.js";
import { themeColors } from "../layout/theme-map.js";

export function RailsView({ state, width, rows }: ViewProps): React.JSX.Element {
  const rails = state.rails;

  if (!rails || rails.status === "disabled") {
    return (
      <Box flexDirection="column" height={rows}>
        <Text color={themeColors().mutedForeground}>
          Rails project not detected. Start working in a Rails project to see Rails-specific information.
        </Text>
      </Box>
    );
  }

  const byType = rails.byType ?? {};
  const entries = [
    { label: "Routes", count: byType.route ?? 0 },
    { label: "Controllers", count: byType.controller ?? 0 },
    { label: "Models", count: byType.model ?? 0 },
    { label: "Tables", count: byType.table ?? 0 },
    { label: "Jobs", count: byType.job ?? 0 },
    { label: "Mailers", count: byType.mailer ?? 0 },
    { label: "Services", count: byType.service ?? 0 },
    { label: "Policies", count: byType.policy ?? 0 },
    { label: "Specs", count: byType.spec ?? 0 },
    { label: "Migrations", count: byType.migration ?? 0 },
    { label: "Views", count: byType.view ?? 0 },
  ];

  // Side-by-side breakdown in 3 columns
  const colWidth = Math.max(15, Math.floor((width - 4) / 3));

  return (
    <Box flexDirection="column" height={rows}>
      <Box height={1} marginBottom={1}>
        <Text bold color={themeColors().error}>
          Rails Project Metadata
        </Text>
      </Box>
      <Box height={1}>
        <Text>
          <Text color={themeColors().mutedForeground}>Rails Version : </Text>
          <Text bold color={themeColors().info}>
            {rails.railsVersion ?? "unknown"}
          </Text>
        </Text>
      </Box>
      <Box height={1}>
        <Text>
          <Text color={themeColors().mutedForeground}>Ruby Version : </Text>
          <Text bold color={themeColors().info}>
            {rails.rubyVersion ?? "unknown"}
          </Text>
        </Text>
      </Box>
      <Box height={1} marginBottom={1}>
        <Text>
          <Text color={themeColors().mutedForeground}>Test Framework: </Text>
          <Text bold color={themeColors().info}>
            {rails.testFramework ?? "unknown"}
          </Text>
        </Text>
      </Box>

      <Box height={1} marginBottom={1}>
        <Text bold color={themeColors().error}>
          Semantic Graph Stats
        </Text>
      </Box>
      <Box height={1}>
        <Text>
          <Text color={themeColors().mutedForeground}>Total Entities: </Text>
          <Text bold color={themeColors().foreground}>
            {rails.entityCount}
          </Text>
        </Text>
      </Box>
      <Box height={1} marginBottom={1}>
        <Text>
          <Text color={themeColors().mutedForeground}>Relationships : </Text>
          <Text bold color={themeColors().foreground}>
            {rails.edgeCount}
          </Text>
        </Text>
      </Box>

      <Box height={1} marginBottom={1}>
        <Text bold color={themeColors().error}>
          Entity Breakdown
        </Text>
      </Box>
      <Box flexDirection="column">
        {(() => {
          const chunked: (typeof entries)[] = [];
          for (let i = 0; i < entries.length; i += 3) {
            chunked.push(entries.slice(i, i + 3));
          }
          return chunked.map((row, rIdx) => (
            <Box key={rIdx} flexDirection="row" width={width}>
              {row.map(({ label, count }) => (
                <Box key={label} width={colWidth} height={1}>
                  <Text>
                    <Text color={themeColors().mutedForeground}>{label.padEnd(12)}: </Text>
                    <Text bold color={themeColors().warning}>
                      {count}
                    </Text>
                  </Text>
                </Box>
              ))}
            </Box>
          ));
        })()}
      </Box>

      {rails.scannerErrors.length > 0 && (
        <>
          <Box height={1} marginTop={1}>
            <Text bold color={themeColors().error}>
              Scanner Errors ({rails.scannerErrors.length})
            </Text>
          </Box>
          {rails.scannerErrors.slice(0, 5).map((err, i) => (
            <Box key={i} height={1} marginLeft={2}>
              <Text color={themeColors().error} wrap="truncate">
                {err.slice(0, width - 6)}
              </Text>
            </Box>
          ))}
        </>
      )}
    </Box>
  );
}
