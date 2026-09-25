const API_URL = "https://veyrohood-api-v2.mdb885941.workers.dev";
const TREASURY = "0xf6F80827cBAf83798c7763FCd915C0068F2bE60C";
const PAY_AMOUNT = 20000n;
const TOKENS = {"1":"0xe343167631d89B6Ffc58B88d6b7fB0228795491D","4663":"0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"};
const CHAINS = {
  "1": { chainId: "0x1", chainName: "Ethereum", rpcUrls: ["https://ethereum-rpc.publicnode.com"], nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://etherscan.io"] },
  "4663": { chainId: "0x1237", chainName: "Robinhood Chain", rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"], nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] }
};
window.VH = { API_URL, TREASURY, PAY_AMOUNT, TOKENS, CHAINS, provider: null, wallet: null };
function toHex(v){ return "0x" + v.toString(16); }
function pad64(hex){ return hex.replace(/^0x/, "").padStart(64, "0"); }
function discoverProviders(){
  const found = new Map();
  window.addEventListener("eip6963:announceProvider", ev => { const d = ev.detail; if (d && d.info && d.provider) found.set(d.info.uuid || d.info.name, d); });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const fallbacks = [[window.ethereum, "Browser EVM"],[window.okxwallet, "OKX Wallet"],[window.rabby, "Rabby"],[window.bitkeep && window.bitkeep.ethereum, "Bitget"],[window.coinbaseWalletExtension, "Coinbase"],[window.tokenpocket, "TokenPocket"],[window.trustwallet, "Trust Wallet"],[window.phantom && window.phantom.ethereum, "Phantom EVM"]];
  fallbacks.forEach(([p, name]) => { if (p && p.request) found.set(name, { info: { name, uuid: name }, provider: p }); });
  if (window.ethereum && window.ethereum.providers) { window.ethereum.providers.forEach((p, i) => found.set("inj-"+i, { info: { name: p.isMetaMask ? "MetaMask" : p.isRabby ? "Rabby" : "EVM Wallet "+(i+1), uuid: "inj-"+i }, provider: p })); }
  return [...found.values()];
}
async function switchChain(chainId){
  const cfg = CHAINS[String(chainId)];
  try { await window.VH.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: cfg.chainId }] }); }
  catch (error) { if (error && (error.code === 4902 || String(error.message||"").includes("Unrecognized"))) { await window.VH.provider.request({ method: "wallet_addEthereumChain", params: [cfg] }); return; } throw error; }
}
async function connectFlow(pickId, onReady, onError){
  const list = discoverProviders();
  const box = document.getElementById(pickId);
  if (!list.length) return onError("No EVM wallet found. Open this site in a wallet browser.");
  async function use(item){ window.VH.provider = item.provider; const accounts = await item.provider.request({ method: "eth_requestAccounts" }); window.VH.wallet = accounts[0]; if (box) box.style.display = "none"; onReady(window.VH.wallet, item.info.name); }
  if (list.length === 1) return use(list[0]).catch(e => onError(e.message));
  if (!box) return use(list[0]).catch(e => onError(e.message));
  box.style.display = "block";
  box.innerHTML = list.map((w,i) => "<button type='button' data-i='"+i+"'>"+w.info.name+"</button>").join("");
  box.querySelectorAll("button").forEach(btn => btn.onclick = () => use(list[Number(btn.dataset.i)]).catch(e => onError(e.message)));
}
window.VH.toHex = toHex; window.VH.pad64 = pad64; window.VH.switchChain = switchChain; window.VH.connectFlow = connectFlow;
