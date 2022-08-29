import Api42 from '../src/index';

it("Should instantiate", () => {
    const api = new Api42([
        {
            client_id: "test",
            client_secret: "test"
        },
    ]);
    expect(api).toBeInstanceOf(Api42);
})
