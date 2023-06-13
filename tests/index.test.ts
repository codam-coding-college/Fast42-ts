import Fast42 from '../src/index';

const client_id = "test";
const client_secret = "test";

it("Should instantiate", () => {
    const api = new Fast42([
        {
            client_id: client_id,
            client_secret: client_secret,
        },
    ]);
    expect(api).toBeInstanceOf(Fast42);
})

it("Should instantiate using Redis", () => {
    const api = new Fast42([
        {
            client_id: client_id,
            client_secret: client_secret,
        },
    ], 0, 2000, {
        host: "localhost",
        port: 6379,
        password: undefined,
    });
    expect(api).toBeInstanceOf(Fast42);
})

// it("initializes using real keys", async () => {
//     const api = await (new Fast42([
//         {
//             client_id: client_id,
//             client_secret: client_secret
//         },
//     ], 0, 2000, {
//         host: "localhost",
//         port: 6379,
//         password: undefined,
//     }).init());
//     expect(api).toBeInstanceOf(Fast42);
//     await api.disconnect();
// })

// jest.setTimeout(10000)
// it("Do a job using redis", async () => {
//     const api = await (new Fast42([
//         {
//             client_id: client_id,
//             client_secret: client_secret
//         },
//     ], 0, 2000, {
//         host: "127.0.0.1",
//         port: 6379,
//     }).init());
//     const job = await api.doJob(() => {
//         console.log("Doing job");
//         return new Promise((resolve, reject) => {
//             setTimeout(() => {
//                 resolve("done");
//             }, 1000);
//         })
//     });
//     expect(job).toBe("done");
//     await api.disconnect();
// })

// it("Make 1 request", async () => {
//     const api = await (new Fast42([
//         {
//             client_id: client_id,
//             client_secret: client_secret
//         },
//     ], 0, 2000, {
//         host: "127.0.0.1",
//         port: 6379,
//     }).init());
//     const job = await api.get("/projects/1328");    
//     const item = await job.json();
//     expect(item).toHaveProperty("id");
//     await api.disconnect();
// })
