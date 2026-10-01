import React, { lazy } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import PageLoadMotion from "./components/ui/PageLoadMotion";
import { ErrorBoundary } from "./components/error/ErrorBoundary";

// Route code stays local in the Tauri bundle but is evaluated only when used.
const RefactoredMainLayout = lazy(() => import('./components/RefactoredMainLayout'));
const NewOrderPage = lazy(() => import('./pages/NewOrderPage'));

export interface AppRoutesProps {
  onLogout: () => void;
  onOpenConnectionSettings: (section?: 'recovery' | null) => void;
}

/**
 * The logged-in POS routes (App.tsx renders them inside its Suspense). Every
 * route but /new-order renders the main layout; /new-order renders the
 * order-taking page alone. App-level listeners that must work on every page
 * (the incoming-order alert, the cancellation notice) are mounted in App.tsx
 * beside these routes, never inside one.
 *
 * The routes have their own error boundary (the same fallback the App-level
 * one shows), so a page that fails to render is replaced by that fallback
 * alone: it never reaches the App-level boundary, which would unmount the
 * listeners beside the routes and silence the incoming-order alert. The
 * boundary resets when the pathname changes after a crash; a healthy page is
 * never remounted by it.
 */
export function AppRoutes({ onLogout, onOpenConnectionSettings }: AppRoutesProps) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary resetKey={pathname}>
      <Routes>
        <Route
          path="/"
          element={
            <RefactoredMainLayout
              onLogout={onLogout}
              onOpenConnectionSettings={onOpenConnectionSettings}
            />
          }
        />
        <Route
          path="/dashboard"
          element={
            <RefactoredMainLayout
              onLogout={onLogout}
              onOpenConnectionSettings={onOpenConnectionSettings}
            />
          }
        />
        <Route
          path="/new-order"
          element={
            <PageLoadMotion animationKey="new-order" className="h-full min-h-0">
              <NewOrderPage />
            </PageLoadMotion>
          }
        />
        <Route
          path="*"
          element={
            <RefactoredMainLayout
              onLogout={onLogout}
              onOpenConnectionSettings={onOpenConnectionSettings}
            />
          }
        />
      </Routes>
    </ErrorBoundary>
  );
}

export default AppRoutes;
