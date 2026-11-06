import { parseAbi } from "viem";

export const registryAbi = parseAbi([
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function getState(uint256 anyId) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource) state)",
  "function roles(uint256 resource,address account) view returns (uint256)",
  "function roleCount(uint256 resource) view returns (uint256)",
  "function hasRoles(uint256 resource,uint256 roleBitmap,address account) view returns (bool)",
  "function register(string label,address owner,address registry,address resolver,uint256 roleBitmap,uint64 expiry) returns (uint256)",
  "function setResolver(uint256 anyId,address resolver)",
  "function setSubregistry(uint256 anyId,address registry)",
]);

export const resolverAbi = parseAbi([
  "function initialize((address account,uint256 roleBitmap)[] grants,bytes[] calls)",
  "function roles(uint256 resource,address account) view returns (uint256)",
  "function roleCount(uint256 resource) view returns (uint256)",
  "function hasRoles(uint256 resource,uint256 roleBitmap,address account) view returns (bool)",
  "function grantSetterRoles(bytes setter,address account) returns (bool)",
  "function revokeRoles(uint256 resource,uint256 roleBitmap,address account) returns (bool)",
  "function setText(bytes name,string key,string value)",
  "function resolve(bytes name,bytes data) view returns (bytes)",
  "function getRecordId(bytes32 node) view returns (uint256)",
]);

export const factoryAbi = parseAbi([
  "function verifyContract(address proxy) view returns (address implementation)",
  "function predictProxyAddress(address deployer,uint256 salt) view returns (address)",
  "function deployProxy(address implementation,uint256 salt,bytes data) returns (address)",
]);

export const registryInitAbi = parseAbi([
  "function initialize((address account,uint256 roleBitmap)[] grants)",
]);

export const universalAbi = parseAbi(["function ROOT_REGISTRY() view returns (address)", "function isENSv2() view returns (bool)"]);
export const textProfileAbi = parseAbi(["function text(bytes32 node,string key) view returns (string)"]);
