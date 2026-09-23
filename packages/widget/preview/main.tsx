import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import JaiSupportWidget from '../src/JaiSupportWidget';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <JaiSupportWidget
      appId="375fbbd6-045b-40ce-9d12-bf1196c5fd9f"
      productName="JStreams"
      supabaseUrl="https://ahsxnoqfbqpacbrygdxh.supabase.co"
    />
  </StrictMode>,
);