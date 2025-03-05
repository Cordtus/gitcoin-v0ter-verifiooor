// Function to convert a hexadecimal string to a decimal number
function hexToDecimal(hexString) {
  if (typeof hexString !== 'string' || hexString.trim() === '') {
    console.error("Please provide a valid hexadecimal string.");
    return;
  }
  
  // Remove '0x' prefix if present
  const cleanHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
  
  // Convert the hex string to decimal
  let decimalValue = parseInt(cleanHex, 16);
  
  if (isNaN(decimalValue)) {
    console.error("Invalid hexadecimal string. Could not convert to decimal.");
  } else {
    console.log(`Hexadecimal: ${hexString}`);
    console.log(`Decimal: ${decimalValue}`);
  }
}

// Example usage
const hexInput = process.argv[2]; // Accept hex string as command-line argument

if (hexInput) {
  hexToDecimal(hexInput);
} else {
  console.log("Usage: node hextodec.js <hexString>");
}