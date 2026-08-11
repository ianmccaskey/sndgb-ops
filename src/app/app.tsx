'use client';

import '@/index.css';
import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from '@/app/AppContext';
import { ImportRunnerProvider, ImportProgressWidget } from '@/app/ImportRunner';
import { AppLayout } from '@/app/layout/AppLayout';
import { HomePage } from '@/app/pages/HomePage';
import { OrdersPage } from '@/app/pages/orders/OrdersPage';
import { ImportPage } from '@/app/pages/orders/ImportPage';
import { ReconPage } from '@/app/pages/recon/ReconPage';
import { VendorsPage } from '@/app/pages/vendors/VendorsPage';
import { ProductsPage } from '@/app/pages/products/ProductsPage';
import { FulfillmentPage } from '@/app/pages/fulfillment/FulfillmentPage';
import { FinancialsPage } from '@/app/pages/financials/FinancialsPage';
import { SettingsPage } from '@/app/pages/settings/SettingsPage';

function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <ImportRunnerProvider>
        <AppLayout>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/orders" element={<OrdersPage />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/recon" element={<ReconPage />} />
            <Route path="/vendors" element={<VendorsPage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/fulfillment" element={<FulfillmentPage />} />
            <Route path="/financials" element={<FinancialsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
          <ImportProgressWidget />
        </AppLayout>
        </ImportRunnerProvider>
      </AppProvider>
    </BrowserRouter>
  );
}

export default App;
