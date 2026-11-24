import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from './components/Layout'
import { DashboardPage } from './pages/DashboardPage'
import { GoLivePage } from './pages/GoLivePage'
import { PilotPage } from './pages/PilotPage'
import { RecordDemoPage } from './pages/RecordDemoPage'
import { RunOfShowPage } from './pages/RunOfShowPage'
import { WhatsAppDemoPage } from './pages/WhatsAppDemoPage'
import { BusinessProvider } from './store/BusinessContext'
import { DemoProvider } from './store/DemoContext'
import { lazy, Suspense } from 'react'

const ConsoleApp = lazy(() => import('./console/ConsoleApp'))

function ConsoleRoute() {
  return (
    <Suspense fallback={<div style={{ padding: 24, font: '14px system-ui', color: '#8d8c87' }}>Loading…</div>}>
      <ConsoleApp />
    </Suspense>
  )
}

function RootRedirect() {
  const { search } = useLocation()
  // Old links with ?biz= keep opening the original demo; everything else opens the console
  return <Navigate to={search.includes('biz=') ? `/dashboard${search}` : '/app'} replace />
}

export default function App() {
  return (
    <BusinessProvider>
      <DemoProvider>
        <Routes>
          <Route path="/app" element={<ConsoleRoute />} />
          <Route path="/app/:tenantId" element={<ConsoleRoute />} />
          <Route path="/app/:tenantId/:section" element={<ConsoleRoute />} />
          <Route path="/app/:tenantId/:section/:callId" element={<ConsoleRoute />} />
          <Route element={<Layout />}>
            <Route path="/" element={<RootRedirect />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/whatsapp-demo" element={<WhatsAppDemoPage />} />
            <Route path="/go-live" element={<GoLivePage />} />
            <Route path="/pilot" element={<PilotPage />} />
            <Route path="/run-of-show" element={<RunOfShowPage />} />
            <Route path="/record-demo" element={<RecordDemoPage />} />
          </Route>
        </Routes>
      </DemoProvider>
    </BusinessProvider>
  )
}
