import type { AppProps } from 'next/app';
import '@solana/wallet-adapter-react-ui/styles.css';
import '../styles/globals.css';
import { WalletProvider } from '../src/WalletProvider';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <WalletProvider>
      <Component {...pageProps} />
    </WalletProvider>
  );
}
