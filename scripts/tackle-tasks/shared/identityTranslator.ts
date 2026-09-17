// Identity translator: forwards a hop's payload unchanged. Used where an overridden hop needs no reshaping.
const payload = JSON.parse(process.argv[2] ?? "{}");
console.log(JSON.stringify(payload));
