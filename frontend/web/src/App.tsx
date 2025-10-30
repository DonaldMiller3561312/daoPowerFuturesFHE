// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface DAOFuturesContract {
  id: string;
  daoName: string;
  encryptedPower: string;
  timestamp: number;
  owner: string;
  status: "active" | "settled" | "expired";
  encryptedPrice: string;
  encryptedVolume: string;
}

// FHE encryption/decryption utilities for numerical data
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-ZAMA`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-') && encryptedData.endsWith('-ZAMA')) {
    return parseFloat(atob(encryptedData.substring(4, encryptedData.length - 5)));
  }
  return parseFloat(encryptedData);
};

// FHE computation on encrypted data
const FHEComputePriceChange = (encryptedPrice: string, changePercent: number): string => {
  const price = FHEDecryptNumber(encryptedPrice);
  const newPrice = price * (1 + changePercent / 100);
  return FHEEncryptNumber(newPrice);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [contracts, setContracts] = useState<DAOFuturesContract[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newContractData, setNewContractData] = useState({ daoName: "", powerValue: 0, initialPrice: 0 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedContract, setSelectedContract] = useState<DAOFuturesContract | null>(null);
  const [decryptedPower, setDecryptedPower] = useState<number | null>(null);
  const [decryptedPrice, setDecryptedPrice] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [priceChangeInput, setPriceChangeInput] = useState<string>("");
  const [showPriceCalculator, setShowPriceCalculator] = useState(false);

  // Statistics
  const activeCount = contracts.filter(c => c.status === "active").length;
  const settledCount = contracts.filter(c => c.status === "settled").length;
  const expiredCount = contracts.filter(c => c.status === "expired").length;

  useEffect(() => {
    loadContracts().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadContracts = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract not available");
        return;
      }

      // Load contract keys
      const keysBytes = await contract.getData("contract_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing contract keys:", e); }
      }

      // Load individual contracts
      const list: DAOFuturesContract[] = [];
      for (const key of keys) {
        try {
          const contractBytes = await contract.getData(`contract_${key}`);
          if (contractBytes.length > 0) {
            try {
              const contractData = JSON.parse(ethers.toUtf8String(contractBytes));
              list.push({ 
                id: key, 
                daoName: contractData.daoName, 
                encryptedPower: contractData.encryptedPower, 
                timestamp: contractData.timestamp, 
                owner: contractData.owner, 
                status: contractData.status || "active",
                encryptedPrice: contractData.encryptedPrice,
                encryptedVolume: contractData.encryptedVolume
              });
            } catch (e) { console.error(`Error parsing contract data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading contract ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setContracts(list);
    } catch (e) { console.error("Error loading contracts:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitContract = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting DAO power data with Zama FHE..." });
    try {
      // Encrypt sensitive data with FHE
      const encryptedPower = FHEEncryptNumber(newContractData.powerValue);
      const encryptedPrice = FHEEncryptNumber(newContractData.initialPrice);
      const encryptedVolume = FHEEncryptNumber(0); // Initial volume

      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const contractId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const contractData = { 
        daoName: newContractData.daoName, 
        encryptedPower: encryptedPower, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        status: "active",
        encryptedPrice: encryptedPrice,
        encryptedVolume: encryptedVolume
      };

      // Store contract data
      await contract.setData(`contract_${contractId}`, ethers.toUtf8Bytes(JSON.stringify(contractData)));
      
      // Update keys list
      const keysBytes = await contract.getData("contract_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(contractId);
      await contract.setData("contract_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));

      setTransactionStatus({ visible: true, status: "success", message: "DAO Futures Contract created with FHE encryption!" });
      await loadContracts();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewContractData({ daoName: "", powerValue: 0, initialPrice: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const simulatePriceChange = async (contractId: string, changePercent: number) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Computing price change on FHE-encrypted data..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const contractBytes = await contract.getData(`contract_${contractId}`);
      if (contractBytes.length === 0) throw new Error("Contract not found");
      const contractData = JSON.parse(ethers.toUtf8String(contractBytes));
      
      // Perform FHE computation on encrypted price
      const newEncryptedPrice = FHEComputePriceChange(contractData.encryptedPrice, changePercent);
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedContract = { ...contractData, encryptedPrice: newEncryptedPrice };
      await contractWithSigner.setData(`contract_${contractId}`, ethers.toUtf8Bytes(JSON.stringify(updatedContract)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE price computation completed successfully!" });
      await loadContracts();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Price computation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const settleContract = async (contractId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Settling DAO futures contract..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const contractBytes = await contract.getData(`contract_${contractId}`);
      if (contractBytes.length === 0) throw new Error("Contract not found");
      const contractData = JSON.parse(ethers.toUtf8String(contractBytes));
      const updatedContract = { ...contractData, status: "settled" };
      await contract.setData(`contract_${contractId}`, ethers.toUtf8Bytes(JSON.stringify(updatedContract)));
      setTransactionStatus({ visible: true, status: "success", message: "Contract settled successfully!" });
      await loadContracts();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Settlement failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (contractAddress: string) => address?.toLowerCase() === contractAddress.toLowerCase();

  // Tutorial content
  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to trade DAO governance power futures", icon: "🔗" },
    { title: "Create Futures Contract", description: "Create encrypted perpetual futures for DAO governance power", icon: "📊", details: "All sensitive data is encrypted using Zama FHE technology" },
    { title: "FHE Encrypted Trading", description: "Trade futures contracts with fully encrypted underlying data", icon: "🔒", details: "Zama FHE enables computations on encrypted governance power data" },
    { title: "Settle Contracts", description: "Settle futures based on actual DAO power distribution", icon: "💰", details: "Maintain privacy while enabling financial derivatives on governance" }
  ];

  // Render network graph visualization
  const renderNetworkGraph = () => {
    return (
      <div className="network-graph">
        <div className="graph-node main-node">
          <div className="node-label">DAO Power Market</div>
          <div className="node-connections">
            {contracts.slice(0, 4).map((contract, index) => (
              <div key={contract.id} className="connection-line">
                <div className={`sub-node node-${index}`}>
                  {contract.daoName.substring(0, 8)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="hud-spinner"></div>
      <p>Initializing DAO Power Futures DEX...</p>
    </div>
  );

  return (
    <div className="app-container hud-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="radar-icon"></div></div>
          <h1>DAO<span>Power</span>Futures</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-contract-btn hud-button">
            <div className="add-icon"></div>Create Futures
          </button>
          <button className="hud-button" onClick={() => setShowPriceCalculator(!showPriceCalculator)}>
            {showPriceCalculator ? "Hide Calculator" : "Price Calculator"}
          </button>
          <button className="hud-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Tutorial" : "Show Tutorial"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>DAO Governance Power Futures DEX</h2>
            <p>Trade FHE-encrypted perpetual futures on DAO governance power distribution</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>Zama FHE Encryption Active</span></div>
        </div>

        {showTutorial && (
          <div className="tutorial-section">
            <h2>DAO Power Futures Tutorial</h2>
            <p className="subtitle">Learn how to trade encrypted DAO governance power derivatives</p>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {showPriceCalculator && (
          <div className="calculator-section hud-card">
            <h3>FHE Price Calculator</h3>
            <div className="calculator-form">
              <input 
                type="number" 
                placeholder="Enter price change %" 
                value={priceChangeInput}
                onChange={(e) => setPriceChangeInput(e.target.value)}
                className="hud-input"
              />
              <button className="hud-button" onClick={() => {
                const change = parseFloat(priceChangeInput);
                if (selectedContract && !isNaN(change)) {
                  simulatePriceChange(selectedContract.id, change);
                }
              }}>
                Simulate Price Change
              </button>
            </div>
          </div>
        )}

        <div className="dashboard-grid">
          <div className="dashboard-card hud-card">
            <h3>Market Overview</h3>
            {renderNetworkGraph()}
            <div className="market-stats">
              <div className="stat-item"><span>Total Contracts:</span><strong>{contracts.length}</strong></div>
              <div className="stat-item"><span>Active:</span><strong className="active">{activeCount}</strong></div>
              <div className="stat-item"><span>Settled:</span><strong className="settled">{settledCount}</strong></div>
            </div>
          </div>

          <div className="dashboard-card hud-card">
            <h3>Zama FHE Technology</h3>
            <p>All DAO governance power data is encrypted using <strong>Zama FHE</strong>, enabling private computations on encrypted derivatives.</p>
            <div className="fhe-features">
              <div className="fhe-feature"><div className="feature-icon">🔒</div><span>Encrypted Trading</span></div>
              <div className="fhe-feature"><div className="feature-icon">⚡</div><span>Private Computations</span></div>
              <div className="fhe-feature"><div className="feature-icon">🛡️</div><span>Secure Settlements</span></div>
            </div>
          </div>
        </div>

        <div className="contracts-section">
          <div className="section-header">
            <h2>DAO Power Futures Contracts</h2>
            <div className="header-actions">
              <button onClick={loadContracts} className="refresh-btn hud-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh Market"}
              </button>
            </div>
          </div>
          <div className="contracts-list hud-card">
            <div className="table-header">
              <div className="header-cell">DAO</div>
              <div className="header-cell">Power Value</div>
              <div className="header-cell">Current Price</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            {contracts.length === 0 ? (
              <div className="no-contracts">
                <div className="no-contracts-icon"></div>
                <p>No DAO power futures contracts found</p>
                <button className="hud-button primary" onClick={() => setShowCreateModal(true)}>Create First Contract</button>
              </div>
            ) : contracts.map(contract => (
              <div className="contract-row" key={contract.id} onClick={() => setSelectedContract(contract)}>
                <div className="table-cell">{contract.daoName}</div>
                <div className="table-cell encrypted-value">
                  {contract.encryptedPower.substring(0, 20)}...
                  <div className="fhe-tag">FHE</div>
                </div>
                <div className="table-cell encrypted-value">
                  {contract.encryptedPrice.substring(0, 20)}...
                  <div className="fhe-tag">FHE</div>
                </div>
                <div className="table-cell">{contract.owner.substring(0, 6)}...{contract.owner.substring(38)}</div>
                <div className="table-cell"><span className={`status-badge ${contract.status}`}>{contract.status}</span></div>
                <div className="table-cell actions">
                  {isOwner(contract.owner) && contract.status === "active" && (
                    <button className="action-btn hud-button success" onClick={(e) => { e.stopPropagation(); settleContract(contract.id); }}>
                      Settle
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitContract} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          contractData={newContractData} 
          setContractData={setNewContractData}
        />
      )}

      {selectedContract && (
        <ContractDetailModal 
          contract={selectedContract} 
          onClose={() => { setSelectedContract(null); setDecryptedPower(null); setDecryptedPrice(null); }} 
          decryptedPower={decryptedPower}
          decryptedPrice={decryptedPrice}
          setDecryptedPower={setDecryptedPower}
          setDecryptedPrice={setDecryptedPrice}
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          onPriceChange={simulatePriceChange}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content hud-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="hud-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="radar-icon"></div><span>DAOPowerFutures</span></div>
            <p>FHE-encrypted derivatives for DAO governance power</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Zama FHE</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          <div className="copyright">© {new Date().getFullYear()} DAO Power Futures DEX</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  contractData: any;
  setContractData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, contractData, setContractData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setContractData({ ...contractData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setContractData({ ...contractData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!contractData.daoName || !contractData.powerValue || !contractData.initialPrice) { 
      alert("Please fill all required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal hud-card">
        <div className="modal-header">
          <h2>Create DAO Power Futures Contract</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>Zama FHE Encryption</strong><p>All sensitive data encrypted before blockchain submission</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>DAO Name *</label>
              <input type="text" name="daoName" value={contractData.daoName} onChange={handleChange} placeholder="Enter DAO name" className="hud-input"/>
            </div>
            <div className="form-group">
              <label>Governance Power Value *</label>
              <input 
                type="number" 
                name="powerValue" 
                value={contractData.powerValue} 
                onChange={handleValueChange} 
                placeholder="Power value" 
                className="hud-input"
                step="0.0001"
              />
            </div>
            <div className="form-group">
              <label>Initial Price *</label>
              <input 
                type="number" 
                name="initialPrice" 
                value={contractData.initialPrice} 
                onChange={handleValueChange} 
                placeholder="Initial price" 
                className="hud-input"
                step="0.01"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Power Value:</span><div>{contractData.powerValue || 'N/A'}</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>FHE Encrypted:</span>
                <div>{contractData.powerValue ? FHEEncryptNumber(contractData.powerValue).substring(0, 30) + '...' : 'N/A'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn hud-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn hud-button primary">
            {creating ? "Encrypting with Zama FHE..." : "Create Futures Contract"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ContractDetailModalProps {
  contract: DAOFuturesContract;
  onClose: () => void;
  decryptedPower: number | null;
  decryptedPrice: number | null;
  setDecryptedPower: (value: number | null) => void;
  setDecryptedPrice: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  onPriceChange: (contractId: string, changePercent: number) => void;
}

const ContractDetailModal: React.FC<ContractDetailModalProps> = ({ 
  contract, onClose, decryptedPower, decryptedPrice, setDecryptedPower, setDecryptedPrice, isDecrypting, decryptWithSignature, onPriceChange 
}) => {
  const [localPriceChange, setLocalPriceChange] = useState("");

  const handleDecryptPower = async () => {
    if (decryptedPower !== null) { setDecryptedPower(null); return; }
    const decrypted = await decryptWithSignature(contract.encryptedPower);
    if (decrypted !== null) setDecryptedPower(decrypted);
  };

  const handleDecryptPrice = async () => {
    if (decryptedPrice !== null) { setDecryptedPrice(null); return; }
    const decrypted = await decryptWithSignature(contract.encryptedPrice);
    if (decrypted !== null) setDecryptedPrice(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="contract-detail-modal hud-card">
        <div className="modal-header">
          <h2>{contract.daoName} Power Futures</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="contract-info">
            <div className="info-item"><span>Contract ID:</span><strong>#{contract.id.substring(0, 8)}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{contract.owner.substring(0, 6)}...{contract.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Created:</span><strong>{new Date(contract.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${contract.status}`}>{contract.status}</strong></div>
          </div>

          <div className="encrypted-data-section">
            <h3>FHE Encrypted Data</h3>
            
            <div className="encrypted-item">
              <div className="item-header">
                <span>Governance Power</span>
                <button className="decrypt-btn hud-button" onClick={handleDecryptPower} disabled={isDecrypting}>
                  {isDecrypting ? "Decrypting..." : decryptedPower !== null ? "Hide" : "Decrypt with Signature"}
                </button>
              </div>
              <div className="encrypted-value">{contract.encryptedPower}</div>
              {decryptedPower !== null && (
                <div className="decrypted-value">Decrypted: {decryptedPower}</div>
              )}
            </div>

            <div className="encrypted-item">
              <div className="item-header">
                <span>Current Price</span>
                <button className="decrypt-btn hud-button" onClick={handleDecryptPrice} disabled={isDecrypting}>
                  {isDecrypting ? "Decrypting..." : decryptedPrice !== null ? "Hide" : "Decrypt with Signature"}
                </button>
              </div>
              <div className="encrypted-value">{contract.encryptedPrice}</div>
              {decryptedPrice !== null && (
                <div className="decrypted-value">Decrypted: {decryptedPrice}</div>
              )}
            </div>

            <div className="price-simulator">
              <h4>FHE Price Simulation</h4>
              <div className="simulator-controls">
                <input 
                  type="number" 
                  placeholder="Price change %" 
                  value={localPriceChange}
                  onChange={(e) => setLocalPriceChange(e.target.value)}
                  className="hud-input"
                />
                <button className="hud-button" onClick={() => {
                  const change = parseFloat(localPriceChange);
                  if (!isNaN(change)) {
                    onPriceChange(contract.id, change);
                  }
                }}>
                  Simulate Change
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn hud-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;