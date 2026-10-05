import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useParams, useRouteError, Link } from 'react-router';
import { DialogHost, Toaster, Spinner, EmptyState, Button } from '@/ui';
import { Compass, TriangleAlert } from 'lucide-react';
import { SettingsHost } from '@/features/settings/SettingsDialog';

const LibraryPage = lazy(() => import('@/features/library/LibraryPage'));
const EditorShell = lazy(() => import('@/features/editor/EditorShell'));
const OverviewPage = lazy(() => import('@/features/editor/OverviewPage'));
const RulesPage = lazy(() => import('@/features/editor/RulesPage'));
const SourcesPage = lazy(() => import('@/features/sources/SourcesPage'));
const CutterPage = lazy(() => import('@/features/cutter/CutterPage'));
const ComponentsPage = lazy(() => import('@/features/components/ComponentsPage'));
const ComponentDetailPage = lazy(() => import('@/features/components/ComponentDetailPage'));
const SetupPage = lazy(() => import('@/features/setup/SetupPage'));
const PlayPage = lazy(() => import('@/features/play/PlayPage'));

export function PageLoader() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', minHeight: 240, color: 'var(--text-3)' }}>
      <Spinner size={22} />
    </div>
  );
}

const S = (node: ReactNode) => <Suspense fallback={<PageLoader />}>{node}</Suspense>;

function RouteError() {
  const err = useRouteError() as any;
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <EmptyState
        icon={TriangleAlert}
        title="Something went wrong"
        description={String(err?.message ?? err?.statusText ?? err ?? 'Unknown error')}
        actions={
          <>
            <Button onClick={() => location.reload()}>Reload</Button>
            <Link to="/">
              <Button variant="primary">Back to library</Button>
            </Link>
          </>
        }
      />
    </div>
  );
}

function NotFound() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <EmptyState
        icon={Compass}
        title="Nothing here"
        description="That page doesn’t exist."
        actions={
          <Link to="/">
            <Button variant="primary">Back to library</Button>
          </Link>
        }
      />
    </div>
  );
}

/**
 * An old bookmark — the PDF slicer (`/edit/sources/<sourceId>`) or the photo importer
 * (`/edit/sources/photos`) — opens the Cutter instead, on that game, and on that file when the URL
 * named one. Nothing 404s.
 */
function ToCutter() {
  const { gameId, sourceId } = useParams();
  const to = `/games/${gameId}/edit/cut${sourceId && sourceId !== 'photos' ? `?source=${sourceId}` : ''}`;
  return <Navigate to={to} replace />;
}

const router = createBrowserRouter([
  { path: '/', element: S(<LibraryPage />), errorElement: <RouteError /> },
  {
    path: '/games/:gameId/edit',
    element: S(<EditorShell />),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="overview" replace /> },
      { path: 'overview', element: S(<OverviewPage />) },
      { path: 'sources', element: S(<SourcesPage />) },
      { path: 'cut', element: S(<CutterPage />) },
      /* the old cutters are gone (v3): their links land in the Cutter, on the same game and file */
      { path: 'sources/photos', element: <ToCutter /> },
      { path: 'sources/:sourceId', element: <ToCutter /> },
      { path: 'components', element: S(<ComponentsPage />) },
      { path: 'components/:componentId', element: S(<ComponentDetailPage />) },
      { path: 'setup', element: S(<SetupPage />) },
      { path: 'rules', element: S(<RulesPage />) },
    ],
  },
  { path: '/games/:gameId/play', element: S(<PlayPage />), errorElement: <RouteError /> },
  { path: '/games/:gameId/play/:sessionId', element: S(<PlayPage />), errorElement: <RouteError /> },
  { path: '*', element: <NotFound /> },
]);

export function App() {
  return (
    <>
      <RouterProvider router={router} />
      <SettingsHost />
      <DialogHost />
      <Toaster />
    </>
  );
}
