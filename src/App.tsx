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
import { LEGACY_PATHS, legacyTarget } from './legacyRoutes'

// Tenant ids only (JSON named export; the rest of each file is tree-shaken out of the main bundle)
const KNOWN_TENANTS = new Set(Object.values(import.meta.glob('../config/tenants/*.json', { eager: true, import: 'id' })))

const ConsoleApp = lazy(() => import('./console/ConsoleApp'))

function ConsoleRoute() {
  return (
    <Suspense fallback={<div style={{ padding: 24, font: '14px system-ui', color: '#8d8c87' }}>Loading…</div>}>
      <ConsoleApp />
    </Suspense>
  )
}

/** Every old public link (LinkedIn, website) lands on the new console; see src/legacyRoutes.ts */
function LegacyRedirect() {
  const { pathname, search } = useLocation()
  return <Navigate to={legacyTarget(pathname, search, (id) => KNOWN_TENANTS.has(id)) ?? '/app'} replace />
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
          {LEGACY_PATHS.map((p) => <Route key={p} path={p} element={<LegacyRedirect />} />)}
          {/* Old demo kept reachable but unlinked */}
          <Route path="/legacy" element={<Layout />}>
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="whatsapp-demo" element={<WhatsAppDemoPage />} />
            <Route path="go-live" element={<GoLivePage />} />
            <Route path="pilot" element={<PilotPage />} />
            <Route path="run-of-show" element={<RunOfShowPage />} />
            <Route path="record-demo" element={<RecordDemoPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </DemoProvider>
    </BusinessProvider>
  )
}
