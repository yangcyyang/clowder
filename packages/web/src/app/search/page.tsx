import { Suspense } from 'react';
import { GlobalSearchPage } from '@/components/GlobalSearchPage';

export default function SearchPage() {
  return (
    <Suspense>
      <GlobalSearchPage />
    </Suspense>
  );
}
