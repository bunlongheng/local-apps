import { Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import StatusPage from './pages/StatusPage'
import CronsPage from './pages/CronsPage'

export default function App() {
  return (
    <>
      <Sidebar />
      <main style={{
        marginLeft: 'var(--sidebar-width)',
        flex: 1,
        padding: '24px 32px',
        minHeight: '100vh',
      }}>
        <Routes>
          <Route path="/" element={<Navigate to="/status" replace />} />
          <Route path="/status" element={<StatusPage />} />
          <Route path="/crons" element={<CronsPage />} />
        </Routes>
      </main>
    </>
  )
}
