// Minimal react-native stand-in for the node test runner. Only the members the
// modules under test actually touch are provided.
module.exports = { Platform: { OS: 'android', select: (o) => o.android } };
