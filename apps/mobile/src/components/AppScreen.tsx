import { SafeAreaView } from "react-native-safe-area-context";
import { ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { useTheme } from "../theme/useTheme";
import { StatusPill } from "./StatusPill";
import { useIrisConnection } from "../connection/useIrisConnection";

type AppScreenProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  scroll?: boolean;
  leadingAction?: React.ReactNode;
  action?: React.ReactNode;
  contentStyle?: ViewStyle;
};

export function AppScreen({
  title,
  subtitle,
  children,
  scroll = true,
  leadingAction,
  action,
  contentStyle,
}: AppScreenProps) {
  const theme = useTheme();
  const { state } = useIrisConnection();
  const styles = createStyles(theme);
  const Content = scroll ? ScrollView : View;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        {leadingAction}
        <View style={styles.headerText}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        {action}
      </View>
      <View style={styles.statusRow}>
        <StatusPill state={state} />
      </View>
      <Content style={styles.content} contentContainerStyle={scroll ? [styles.contentInner, contentStyle] : undefined}>
        {children}
      </Content>
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.colors.screen,
    },
    header: {
      minHeight: 64,
      paddingHorizontal: theme.spacing[4],
      paddingTop: theme.spacing[2],
      paddingBottom: theme.spacing[3],
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing[3],
    },
    headerText: {
      flex: 1,
      minWidth: 0,
      gap: 4,
    },
    title: {
      color: theme.colors.text,
      fontSize: 24,
      fontWeight: "700",
    },
    subtitle: {
      color: theme.colors.textMuted,
      fontSize: 13,
      lineHeight: 18,
    },
    statusRow: {
      paddingHorizontal: theme.spacing[4],
      paddingBottom: theme.spacing[3],
    },
    content: {
      flex: 1,
    },
    contentInner: {
      paddingHorizontal: theme.spacing[4],
      paddingBottom: theme.spacing[8],
      gap: theme.spacing[3],
    },
  });
}
