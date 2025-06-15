import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, StatusBar as RNStatusBar, View } from 'react-native';
import { AgentNotificationBanner } from './components/AgentNotificationBanner';
import { runAgentModuleSelfCheck } from './lib/agent-selfcheck';
import { initRAG, runRAGSelfCheck } from './lib/rag';

export default function RootLayout() {
  const androidTopInset = Platform.OS === 'android' ? (RNStatusBar.currentHeight || 0) : 0;

  useEffect(() => {
    // 异步初始化，不阻塞 UI 渲染
    const initializeApp = async () => {
      try {
        // 启动后自动执行一次 Agent 模块自检，避免手动验证。
        await runAgentModuleSelfCheck();
      } catch (error: any) {
        console.warn('[RootLayout] Agent selfcheck failed:', error?.message || error);
      }

      try {
        // #region agent log
        fetch('http://127.0.0.1:7750/ingest/c7852349-c1c4-418e-b862-f082a33bb43e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'50dec4'},body:JSON.stringify({sessionId:'50dec4',runId:'initial',hypothesisId:'H2',location:'app/_layout.tsx:15',message:'RootLayout initRAG start',data:{platform:Platform.OS},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        // 启动时初始化法律知识库 RAG 索引。
        await initRAG();
      } catch (error: any) {
        // #region agent log
        fetch('http://127.0.0.1:7750/ingest/c7852349-c1c4-418e-b862-f082a33bb43e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'50dec4'},body:JSON.stringify({sessionId:'50dec4',runId:'initial',hypothesisId:'H4',location:'app/_layout.tsx:19',message:'initRAG catch triggered',data:{errorMessage:String(error?.message||error)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        console.warn('[RAG] init failed:', error?.message || error);
      }

      try {
        // 启动时执行 RAG 自检，验证检索链路可运行。
        await runRAGSelfCheck();
      } catch (error: any) {
        console.warn('[RootLayout] RAG selfcheck failed:', error?.message || error);
      }
    };

    initializeApp();
  }, []);

  return (
    <>
      <StatusBar style="dark" translucent={false} />
      <View style={{ flex: 1 }}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { paddingTop: androidTopInset },
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="listing/[id]" />
          <Stack.Screen name="compare" />
          <Stack.Screen name="history" />
          <Stack.Screen name="favorites" />
          <Stack.Screen name="deep-analyses" />
          <Stack.Screen name="platform-login" />
        </Stack>
        <AgentNotificationBanner />
      </View>
    </>
  );
}
