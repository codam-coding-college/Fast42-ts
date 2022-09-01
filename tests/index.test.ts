import Fast42 from '../src/index';

it("Should instantiate", () => {
    const api = new Fast42([
        {
            client_id: "test",
            client_secret: "test"
        },
    ]);
    expect(api).toBeInstanceOf(Fast42);
})
