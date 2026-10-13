import { Navigate, Route, Routes } from "react-router";
import { useAuthMe } from "@/lib/hooks";
import { Layout } from "@/components/Layout";
import { AgentsPage } from "@/pages/Agents";
import { LogsPage } from "@/pages/Logs";
import { Login } from "@/pages/Login";
import { ServersPage } from "@/pages/Servers";
import { SettingsPage } from "@/pages/Settings";
import { UsersPage } from "@/pages/Users";

export function App() {
  const { data: auth, isLoading } = useAuthMe();

  if (isLoading) return null;
  if (!auth?.authenticated) return <Login auth={auth} />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/servers" replace />} />
        <Route path="/servers" element={<ServersPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        {auth.user?.role === "admin" && <Route path="/users" element={<UsersPage />} />}
        <Route path="*" element={<Navigate to="/servers" replace />} />
      </Routes>
    </Layout>
  );
}
