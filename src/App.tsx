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

function RootRedirect() {
  const { search } = useLocation()
  return <Navigate to={`/dashboard${search}`} replace />
}

export default function App() {
  return (
    <BusinessProvider>
      <DemoProvider>
        <Routes>
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
