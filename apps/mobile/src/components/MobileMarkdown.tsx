import { memo, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  parseInlineMarkdown,
  parseMobileMarkdown,
  type MobileMarkdownBlock,
} from "../chat/mobileMarkdown";
import { useTheme } from "../theme/useTheme";

export const MobileMarkdown = memo(function MobileMarkdown({
  content,
  muted = false,
}: {
  content: string;
  muted?: boolean;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const blocks = useMemo(() => parseMobileMarkdown(content), [content]);

  return (
    <View style={styles.root}>
      {blocks.map((block, index) => (
        <MarkdownBlockView
          key={`${block.type}-${index}`}
          block={block}
          muted={muted}
          styles={styles}
        />
      ))}
    </View>
  );
});

function MarkdownBlockView({
  block,
  muted,
  styles,
}: {
  block: MobileMarkdownBlock;
  muted: boolean;
  styles: MobileMarkdownStyles;
}) {
  if (block.type === "heading") {
    return (
      <Text style={[styles.text, styles.heading, block.level <= 1 ? styles.headingLarge : null]}>
        <InlineText content={block.text} muted={muted} styles={styles} />
      </Text>
    );
  }

  if (block.type === "blockquote") {
    return (
      <View style={styles.blockquote}>
        <Text style={[styles.text, styles.mutedText]}>
          <InlineText content={block.text} muted styles={styles} />
        </Text>
      </View>
    );
  }

  if (block.type === "code") {
    return <Text style={styles.codeBlock}>{block.text}</Text>;
  }

  if (block.type === "list") {
    return (
      <View style={styles.list}>
        {block.items.map((item, index) => (
          <View key={`${item.marker}-${item.text}-${index}`} style={[styles.listItem, { marginLeft: item.level * 22 }]}>
            <Text style={styles.listMarker}>{item.ordered ? `${item.marker}.` : "\u2022"}</Text>
            <Text style={[styles.text, styles.listText, muted ? styles.mutedText : null]}>
              <InlineText content={item.text} muted={muted} styles={styles} />
            </Text>
          </View>
        ))}
      </View>
    );
  }

  return (
    <Text style={[styles.text, muted ? styles.mutedText : null]}>
      <InlineText content={block.text} muted={muted} styles={styles} />
    </Text>
  );
}

function InlineText({
  content,
  muted,
  styles,
}: {
  content: string;
  muted: boolean;
  styles: MobileMarkdownStyles;
}) {
  return (
    <>
      {parseInlineMarkdown(content).map((segment, index) => {
        if (segment.type === "code") {
          return <Text key={`${segment.type}-${index}`} style={styles.inlineCode}>{segment.text}</Text>;
        }
        if (segment.type === "strong") {
          return <Text key={`${segment.type}-${index}`} style={styles.strong}>{segment.text}</Text>;
        }
        if (segment.type === "link") {
          return <Text key={`${segment.type}-${index}`} style={styles.link}>{segment.text}</Text>;
        }
        return (
          <Text key={`${segment.type}-${index}`} style={muted ? styles.mutedText : null}>
            {segment.text}
          </Text>
        );
      })}
    </>
  );
}

type MobileMarkdownStyles = ReturnType<typeof createStyles>;

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    root: {
      gap: theme.spacing[3],
    },
    text: {
      color: theme.colors.text,
      fontSize: 16,
      lineHeight: 26,
    },
    mutedText: {
      color: theme.colors.textSecondary,
    },
    heading: {
      color: theme.colors.text,
      fontSize: 17,
      fontWeight: "700",
      lineHeight: 22,
    },
    headingLarge: {
      fontSize: 20,
      lineHeight: 25,
    },
    strong: {
      fontWeight: "700",
    },
    link: {
      color: theme.colors.accentCoolBright,
    },
    inlineCode: {
      overflow: "hidden",
      borderWidth: 1,
      borderColor: theme.colors.input,
      borderRadius: theme.radius.sm,
      color: theme.colors.accentWarning,
      backgroundColor: theme.colors.input,
      fontFamily: theme.typography.fontFamily.mono,
      fontSize: 15,
      lineHeight: 23,
    },
    codeBlock: {
      borderWidth: 1,
      borderColor: theme.colors.accent,
      borderRadius: theme.radius.lg,
      color: theme.colors.textSecondary,
      backgroundColor: theme.colors.surfaceDeep,
      fontFamily: theme.typography.fontFamily.mono,
      fontSize: 13,
      lineHeight: 19,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[3],
    },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.accentCoolBright,
      paddingLeft: theme.spacing[3],
    },
    list: {
      gap: theme.spacing[2],
    },
    listItem: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing[2],
    },
    listMarker: {
      width: 18,
      color: theme.colors.textSecondary,
      fontSize: 17,
      lineHeight: 26,
      textAlign: "center",
    },
    listText: {
      flex: 1,
      minWidth: 0,
    },
  });
}
