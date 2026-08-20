import base64
import unittest

from nacl import encoding, public

from scripts.github_secret import encrypt_secret, set_secret


class GitHubSecretTests(unittest.TestCase):
    def test_sealed_box_round_trip(self):
        private_key = public.PrivateKey.generate()
        encoded_key = private_key.public_key.encode(encoder=encoding.Base64Encoder()).decode("ascii")
        encrypted = encrypt_secret(encoded_key, "not-a-real-secret")
        decrypted = public.SealedBox(private_key).decrypt(base64.b64decode(encrypted)).decode("utf-8")
        self.assertEqual(decrypted, "not-a-real-secret")

    def test_write_output_excludes_secret_and_ciphertext(self):
        private_key = public.PrivateKey.generate()
        encoded_key = private_key.public_key.encode(encoder=encoding.Base64Encoder()).decode("ascii")

        class FakeApi:
            def __init__(self):
                self.payload = None

            def request(self, path, method="GET", payload=None):
                if path.endswith("/public-key"):
                    return {"key_id": "key-id", "key": encoded_key}
                self.payload = payload
                return {}

        api = FakeApi()
        result = set_secret(api, "owner/example", "TEST_SECRET", "not-a-real-secret")
        self.assertEqual(result["name"], "TEST_SECRET")
        self.assertNotIn("not-a-real-secret", str(result))
        self.assertNotIn(api.payload["encrypted_value"], str(result))


if __name__ == "__main__":
    unittest.main()
