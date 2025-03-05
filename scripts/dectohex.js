// Function to convert a decimal number to a hexadecimal string
function decimalToHex(decimalNumber) {
  if (isNaN(decimalNumber)) {
    console.error("Please provide a valid decimal number.");
    return;
  }
  
  // Convert decimal to hexadecimal
  let hexValue = parseInt(decimalNumber).toString(16);
  
  // Output result with '0x' prefix to indicate it's hexadecimal
  console.log(`Decimal: ${decimalNumber}`);
  console.log(`Hexadecimal: 0x${hexValue}`);
}

// Example usage
const decimalInput = process.argv[2]; // Accept decimal number as a command-line argument

if (decimalInput) {
  decimalToHex(decimalInput);
} else {
  console.log("Usage: node dectohex.js <decimalNumber>");
}