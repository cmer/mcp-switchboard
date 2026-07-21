import { Navigate, Route, Routes } from "react-router";
import { useAuthMe } from "@/lib/hooks";
import { Layout } from "@/components/Layout";
import { AgentsPage } from "@/pages/Agents";
import { Login } from "@/pages/Login";
import { ServersPage } from "@/pages/Servers";
import { SettingsPage } from "@/pages/Settings";

export function App() {
  const { data: auth, isLoading } = useAuthMe();

  if (isLoading) return null;
  if (!auth?.authenticated) return <Login needsSetup={auth?.needsSetup ?? false} />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/servers" replace />} />
        <Route path="/servers" element={<ServersPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/servers" replace />} />
      </Routes>
    </Layout>
  );
}
