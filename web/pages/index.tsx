import Head from 'next/head';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import GlobalConfigViewer from '../src/GlobalConfigViewer';

export default function Home() {
  const { publicKey } = useWallet();

  return (
    <div className="container">
      <Head>
        <title>COCO Staking — Frontend</title>
      </Head>
      <main>
        <h1>COCO Staking</h1>
        <div style={{ marginBottom: 12 }}>
          <WalletMultiButton />
        </div>
        <div>
          <strong>Connected:</strong> {publicKey ? publicKey.toBase58() : 'Not connected'}
        </div>
        <hr />
        <GlobalConfigViewer />
      </main>
    </div>
  );
}
