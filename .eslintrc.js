module.exports = {
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: "MemberExpression[object.name='process'][property.name='env']",
        message: "Use config instead of process.env"
      }
    ]
  }
};
